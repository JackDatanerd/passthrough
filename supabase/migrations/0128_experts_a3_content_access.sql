-- Experts audit A3 (Phase 1 database layer, part 1: content access). Redefines the content-access functions of 0124. No new objects.
--
--   * human_job_expert_read: the gate can no longer be NULL (a NULL expert or a NULL window used to GRANT access).
--   * human_job_expert_save / human_job_expert_baseline: a NULL expert or NULL base version no longer slips past; the cover letter follows add_cover_letter.
--   * human_job_unassign: a pending question is closed (it could never be answered or expire) and the wait is folded into the deadlines.
--   * human_job_assign: an expert can never be given their own order (same email as the customer).
-- The customer's free text is scrubbed for the expert in the app layer (lib/expertView.js, audit A5), not here.

create or replace function human_job_expert_read(p_job uuid, p_expert uuid, p_window_days int default 7)
returns jsonb language plpgsql as $$
declare j human_jobs; allowed boolean; out jsonb; win int := coalesce(p_window_days, 7);
begin
  select * into j from human_jobs where id = p_job;
  -- three-valued logic closed: anything that is not a clear yes is a no (a NULL expert or NULL window must never grant)
  allowed := coalesce(found and p_expert is not null and j.expert_id is not distinct from p_expert
    and (j.state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision')
         or (j.state in ('delivered', 'accepted') and coalesce(j.delivered_at, now()) + make_interval(days => win) > now())), false);
  if not allowed then
    insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail)
      values ('expert', p_expert, 'denied_job_access', 'human_job', p_job::text, jsonb_build_object('exists', j.id is not null));
    return null;
  end if;
  insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail)
    values ('expert', p_expert, 'view_job', 'human_job', p_job::text, jsonb_build_object('state', j.state));
  select jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'job_number', j.job_number, 'state', j.state, 'tier', j.tier, 'add_cover_letter', j.add_cover_letter,
            'expert_pay_cents', j.expert_pay_cents, 'currency', j.currency, 'promised_deadline_at', j.promised_deadline_at,
            'internal_deadline_at', j.internal_deadline_at, 'revision_count', j.revision_count,
            'revision_reason', j.revision_reason,
            'revision_due_at', j.revision_due_at, 'version', j.version,
            'brief', j.brief,
            'score_before', j.score_before),
    'source',   (select body from job_documents where job_id = p_job and kind = 'source'   order by version desc limit 1),
    'ai_draft', (select body from job_documents where job_id = p_job and kind = 'ai_draft' order by version desc limit 1),
    'working',  (select jsonb_build_object('version', version, 'body', body, 'cover_letter', cover_letter) from job_documents
                  where job_id = p_job and kind = 'working' order by version desc limit 1),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'body', body, 'status', status,
                  'answer_body', answer_body,
                  'asked_at', asked_at, 'answer_deadline_at', answer_deadline_at) order by seq) from job_questions where job_id = p_job), '[]'::jsonb),
    'materials', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'text', extracted_masked_text) order by created_at)
                  from job_materials where job_id = p_job and kind = 'file' and status = 'ready'), '[]'::jsonb)
  ) into out;
  return out;
end $$;

create or replace function human_job_expert_save(p_job uuid, p_expert uuid, p_base_version int, p_body jsonb, p_cover jsonb, p_seconds int)
returns jsonb language plpgsql as $$
declare j human_jobs; cur int; secs int; cover jsonb;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or p_expert is null or j.expert_id is distinct from p_expert or j.state not in ('claimed', 'in_progress', 'revision') then
    insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail)
      values ('expert', p_expert, 'denied_job_save', 'human_job', p_job::text, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  if p_base_version is null or p_body is null or jsonb_typeof(p_body) <> 'object' then return jsonb_build_object('ok', false, 'reason', 'bad_request'); end if;
  select coalesce(max(version), 0) into cur from job_documents where job_id = p_job and kind = 'working';
  if cur <> p_base_version then return jsonb_build_object('ok', false, 'reason', 'conflict', 'current_version', cur); end if;
  secs := greatest(0, least(coalesce(p_seconds, 0), 600));
  -- the cover letter exists only on a job that bought one; a save that leaves it out keeps the current one
  if j.add_cover_letter then
    cover := coalesce(p_cover, (select cover_letter from job_documents where job_id = p_job and kind = 'working' and version = cur));
  else
    cover := null;
  end if;
  insert into job_documents (job_id, kind, version, body, cover_letter) values (p_job, 'working', cur + 1, p_body, cover);
  update human_jobs set active_edit_seconds = active_edit_seconds + secs,
         state = case when state = 'claimed' then 'in_progress' else state end,
         version = case when state = 'claimed' then version + 1 else version end, updated_at = now() where id = p_job;
  if j.state = 'claimed' then
    insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'started', 'expert', p_expert, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'version', cur + 1);
end $$;

create or replace function human_job_expert_baseline(p_job uuid, p_expert uuid)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job;
  if not found or p_expert is null or j.expert_id is distinct from p_expert or j.state not in ('claimed', 'in_progress', 'revision') then
    insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail) values ('expert', p_expert, 'denied_job_save', 'human_job', p_job::text, '{}'::jsonb);
    return null;
  end if;
  return jsonb_build_object(
    'body', coalesce((select body from job_documents where job_id = p_job and kind = 'ai_draft' order by version desc limit 1),
                     (select body from job_documents where job_id = p_job and kind = 'source' order by version desc limit 1)),
    'cover_letter', (select cover_letter from job_documents where job_id = p_job and kind = 'working' order by version asc limit 1));
end $$;

create or replace function human_job_assign(p_job uuid, p_expert uuid, p_operator uuid, p_max_active int default 2)
returns jsonb language plpgsql as $$
declare j human_jobs; e expert_accounts; active_n int;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state not in ('offered', 'open') then return jsonb_build_object('ok', false, 'reason', 'not_assignable', 'state', j.state); end if;
  select * into e from expert_accounts where id = p_expert for update;
  if not found or not e.enabled or e.status not in ('probation', 'active') or not ('expert' = any (e.roles)) then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible'); end if;
  if e.totp_enabled_at is null then return jsonb_build_object('ok', false, 'reason', 'two_factor_missing'); end if;
  if e.agreement_signed_at is null then return jsonb_build_object('ok', false, 'reason', 'agreement_missing'); end if;
  -- an expert never works on their own order
  if exists (select 1 from users u where u.id = j.customer_user_id and lower(u.email) = e.email) then
    return jsonb_build_object('ok', false, 'reason', 'conflict_of_interest'); end if;
  select count(*) into active_n from human_jobs
    where expert_id = p_expert and state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision');
  if active_n >= p_max_active then return jsonb_build_object('ok', false, 'reason', 'cap', 'active', active_n); end if;
  update human_jobs set state = 'claimed', expert_id = p_expert, claimed_at = now(), version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'taken', 'operator', p_operator, jsonb_build_object('how', 'assigned_by_hand'));
  return jsonb_build_object('ok', true);
end $$;

create or replace function human_job_unassign(p_job uuid, p_operator uuid, p_reason text default null)
returns jsonb language plpgsql as $$
declare j human_jobs; secs int := 0;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state not in ('claimed', 'in_progress', 'waiting_customer') then return jsonb_build_object('ok', false, 'reason', 'not_unassignable', 'state', j.state); end if;
  if j.state = 'waiting_customer' then
    -- the question belonged to the expert who is leaving: close it (the customer could no longer answer it and nothing would expire it)
    -- and fold the wait into the deadlines, exactly as answering or expiring it would have
    secs := greatest(0, floor(extract(epoch from (now() - coalesce(j.pause_started_at, now()))))::int);
    update job_questions set status = 'expired' where job_id = p_job and status = 'pending';
  end if;
  update human_jobs set state = 'offered', expert_id = null, claimed_at = null, version = version + 1, pause_started_at = null,
         paused_seconds = paused_seconds + secs,
         promised_deadline_at = promised_deadline_at + make_interval(secs => secs), internal_deadline_at = internal_deadline_at + make_interval(secs => secs),
         updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'released', 'operator', p_operator,
    jsonb_build_object('reason', left(coalesce(p_reason, ''), 120), 'paused_seconds', secs));
  return jsonb_build_object('ok', true);
end $$;

do $$ declare sig text; begin
  for sig in select unnest(array[
    'human_job_expert_read(uuid, uuid, int)', 'human_job_expert_save(uuid, uuid, int, jsonb, jsonb, int)', 'human_job_expert_baseline(uuid, uuid)',
    'human_job_assign(uuid, uuid, uuid, int)', 'human_job_unassign(uuid, uuid, text)']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (128, '0128_experts_a3_content_access')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 128, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 128;   -- never move the version BACKWARDS (a re-run of an older file)
