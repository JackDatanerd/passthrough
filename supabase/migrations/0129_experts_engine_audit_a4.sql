-- Passthrough Experts: audit section A4 (number 0129: A3 took 0128) (state machine and job engine), pass 1 fixes. See CHANGES-experts-audit-a4-pass1.txt and
-- docs/experts/audit/engine-pass1.md. Nothing is dropped except the ONE old signature of human_job_transition (replaced by a longer one with
-- the same first fifteen parameters, so positional callers keep working). Phase 1 function SIGNATURES are unchanged.
--
--  * job_event_keys remembers the trigger and target, so a reused key for a DIFFERENT move is refused (IDEM_KEY_MISMATCH), not "replayed".
--  * human_jobs.give_back_until (spec 5/6.4) and the guards the spec lists: give-back window, review_required, revision window/reason/once,
--    due-time guards for system triggers, delivered needs its delivery rows (written in the same transaction), take cannot name another expert.
--  * ask_question creates the question inside the transaction; answered / timeout / leaving the wait close it.
--  * graders may do review_approved / sent_back (actor kind 'expert', role checked in the database, never their own job).
--  * sent_back after a revision returns to 'revision' (as Phase 1 does); disputed gets exits; payouts skip disputed jobs.
--  * one SQL function (job_next_action_sync) decides the scheduled action; a trigger on human_jobs keeps job_pauses and job_next_actions
--    right for EVERY writer, Phase 1 functions included. Backfilled pauses are rebuilt correctly (and open ones that are stale are closed).

alter table job_event_keys add column if not exists trigger_name text, add column if not exists to_state text;
alter table human_jobs add column if not exists give_back_until timestamptz;

update system_state set value = jsonb_set(value, '{give_back_window_minutes}', '60'::jsonb)
  where key = 'human_pilot' and not (value ? 'give_back_window_minutes');

-- rules: graders (actor kind expert, role checked in the function), sent_back to revision, and the two ways out of a dispute
update job_transition_rules set actors = array['expert', 'operator'] where trigger in ('review_approved', 'sent_back');
insert into job_transition_rules (from_state, to_state, trigger, actors) values
  ('in_review', 'revision',    'sent_back',                   array['expert', 'operator']),
  ('disputed',  'accepted',    'dispute_resolved_for_expert', array['operator']),
  ('disputed',  'in_progress', 'dispute_dismissed',           array['operator'])
on conflict do nothing;

-- ---- the one rule for "what is this job waiting for" (mirrors nextActionFor in lib/expertRealm/stateMachine.js) --------------------
create or replace function job_next_action_sync(p_job uuid) returns void language plpgsql as $$
declare j human_jobs; na timestamptz; nk text; hrs int;
begin
  select * into j from human_jobs where id = p_job;
  if not found then return; end if;
  if j.state = 'awaiting_payment' then
    select coalesce((value ->> 'pending_expiry_hours')::int, 24) into hrs from system_state where key = 'human_pilot';
    na := j.created_at + make_interval(hours => coalesce(hrs, 24)); nk := 'expire_unpaid';
  elsif j.state in ('offered', 'open', 'claimed', 'in_progress', 'in_review', 'final_checks') then na := j.internal_deadline_at; nk := 'deadline_warning';
  elsif j.state = 'revision' then na := coalesce(j.revision_due_at, j.internal_deadline_at); nk := 'deadline_warning';
  elsif j.state = 'waiting_customer' then
    select q.answer_deadline_at into na from job_questions q where q.job_id = p_job and q.status = 'pending' order by q.seq desc limit 1; nk := 'question_timeout';
  elsif j.state = 'delivered' then na := j.auto_accept_at; nk := 'auto_accept';
  end if;
  if na is not null and nk is not null then
    insert into job_next_actions (job_id, next_action_at, next_action_kind, source) values (p_job, na, nk, 'engine')
      on conflict (job_id) do update set next_action_at = excluded.next_action_at, next_action_kind = excluded.next_action_kind, updated_at = now(), source = 'engine';
  else delete from job_next_actions where job_id = p_job; end if;
end $$;

-- every writer of human_jobs (Phase 1 functions and the engine alike): pause rows follow the wait, the next action follows the state
create or replace function human_jobs_sync_engine() returns trigger language plpgsql as $$
begin
  if old.state is distinct from new.state then
    if old.state = 'waiting_customer' then
      update job_pauses set ended_at = greatest(started_at, now()) where job_id = new.id and ended_at is null;
    end if;
    if new.state = 'waiting_customer' then
      insert into job_pauses (job_id, started_at, reason, source) values (new.id, now(), 'customer_question', 'engine') on conflict do nothing;
    end if;
  end if;
  if new.state in ('offered', 'open') and new.give_back_until is not null then update human_jobs set give_back_until = null where id = new.id; end if;
  perform job_next_action_sync(new.id);
  return null;
end $$;
drop trigger if exists human_jobs_sync_engine_trg on human_jobs;
create trigger human_jobs_sync_engine_trg after update of state, auto_accept_at, internal_deadline_at, revision_due_at on human_jobs
  for each row execute function human_jobs_sync_engine();

-- ---- the transition function, v2 ---------------------------------------------------------------------------------------------------
drop function if exists human_job_transition(uuid, text, text, text, uuid, int, uuid, text, jsonb, text, int, timestamptz, int, timestamptz, timestamptz);
create or replace function human_job_transition(
  p_job uuid, p_to text, p_trigger text, p_actor_kind text, p_actor uuid,
  p_expected_version int default null, p_expert uuid default null,
  p_event_kind text default null, p_detail jsonb default '{}'::jsonb, p_idem_key text default null,
  p_hold_days int default 3, p_auto_accept_at timestamptz default null, p_max_active int default 2,
  p_promised timestamptz default null, p_internal timestamptz default null,
  p_payload jsonb default '{}'::jsonb,            -- ask_question: body, options, answer_hours | answered: answer | request_revision: reason
  p_delivery jsonb default null,                  -- rescan_passed / redeliver: files, score_before, score_after, report, diff, confirmations, summary, note
  p_give_back_minutes int default 60, p_revision_window_days int default 7, p_revision_hours int default 48,
  p_question_max int default 3, p_expiry_hours int default 24, p_answer_hours int default 24
) returns jsonb language plpgsql as $$
declare
  j human_jobs; e expert_accounts; g expert_accounts; r job_transition_rules; k job_event_keys; q job_questions; doc job_documents;
  carrying constant text[] := array['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted'];
  new_expert uuid; secs int := 0; ev bigint; active_n int; prev_state text; had_open boolean := false; req_to text := p_to; is_rev boolean;
  qn int := 0; v_body text; v_answer text; v_reason text; v_hours int; ver int; v_doc uuid; claimed_now boolean;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  p_payload := coalesce(p_payload, '{}'::jsonb);

  if p_idem_key is not null then
    select * into k from job_event_keys where job_id = p_job and idem_key = p_idem_key;
    if found then
      if k.trigger_name is not null and (k.trigger_name is distinct from p_trigger or k.to_state is distinct from req_to) then
        return jsonb_build_object('ok', false, 'code', 'IDEM_KEY_MISMATCH', 'state', j.state);
      end if;
      return jsonb_build_object('ok', true, 'replay', true, 'state', j.state, 'version', j.version, 'event_id', k.event_id);
    end if;
  end if;

  if p_expected_version is not null and j.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'VERSION_CONFLICT', 'state', j.state, 'version', j.version);
  end if;

  -- sent_back returns to 'revision' while a revision is being worked, else to 'in_progress' (the rule Phase 1 human_job_return_to_expert uses)
  if p_trigger = 'sent_back' and p_to in ('in_progress', 'revision') then
    is_rev := j.revision_count > 0 and j.delivered_at is not null and j.revision_requested_at is not null and j.revision_requested_at >= j.delivered_at;
    p_to := case when is_rev then 'revision' else 'in_progress' end;
  end if;

  select * into r from job_transition_rules where from_state = j.state and to_state = p_to and trigger = p_trigger;
  if not found or not (p_actor_kind = any (r.actors)) then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', j.state);
  end if;

  if p_actor_kind = 'expert' and p_trigger in ('review_approved', 'sent_back') then
    select * into g from expert_accounts where id = p_actor;
    if not found or not g.enabled or g.status not in ('probation', 'active') or not ('grader' = any (g.roles)) or j.expert_id is not distinct from p_actor then
      return jsonb_build_object('ok', false, 'code', 'NOT_GRADER', 'state', j.state); end if;
  elsif p_actor_kind = 'expert' and p_trigger <> 'take' and j.expert_id is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'NOT_ASSIGNED', 'state', j.state);
  end if;
  if p_actor_kind = 'customer' and j.customer_user_id is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'NOT_OWNER', 'state', j.state);
  end if;
  if p_trigger = 'take' and p_expert is not null and p_expert is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_MISMATCH', 'state', j.state);
  end if;

  -- guards from engineering spec section 5
  if p_trigger = 'give_back_in_window' and (j.give_back_until is null or now() > j.give_back_until) then
    return jsonb_build_object('ok', false, 'code', 'WINDOW_CLOSED', 'state', j.state); end if;
  if p_trigger in ('deliver', 'redeliver') and j.review_required then
    return jsonb_build_object('ok', false, 'code', 'REVIEW_REQUIRED', 'state', j.state); end if;
  if p_trigger = 'auto_accept' and (j.auto_accept_at is null or j.auto_accept_at > now()) then
    return jsonb_build_object('ok', false, 'code', 'NOT_DUE', 'state', j.state); end if;
  if p_trigger = 'expired' and j.created_at + make_interval(hours => p_expiry_hours) > now() then
    return jsonb_build_object('ok', false, 'code', 'NOT_DUE', 'state', j.state); end if;
  if p_trigger in ('question_timeout', 'answered') then
    select * into q from job_questions where job_id = p_job and status = 'pending' order by seq desc limit 1;
    if not found then return jsonb_build_object('ok', false, 'code', case when p_trigger = 'answered' then 'NO_PENDING_QUESTION' else 'NOT_DUE' end, 'state', j.state); end if;
    if p_trigger = 'question_timeout' and q.answer_deadline_at > now() then return jsonb_build_object('ok', false, 'code', 'NOT_DUE', 'state', j.state); end if;
    if p_trigger = 'answered' then
      v_answer := btrim(coalesce(p_payload ->> 'answer', ''));
      if char_length(v_answer) = 0 or char_length(v_answer) > 2000 then return jsonb_build_object('ok', false, 'code', 'BAD_ANSWER', 'state', j.state); end if;
    end if;
  end if;
  if p_trigger = 'ask_question' then
    select count(*) into qn from job_questions where job_id = p_job;
    if qn >= p_question_max then return jsonb_build_object('ok', false, 'code', 'QUESTION_LIMIT', 'state', j.state); end if;
    v_body := btrim(coalesce(p_payload ->> 'body', ''));
    if char_length(v_body) = 0 or char_length(v_body) > 600 then return jsonb_build_object('ok', false, 'code', 'BAD_QUESTION', 'state', j.state); end if;
  end if;
  if p_trigger = 'request_revision' then
    if j.revision_count >= 1 then return jsonb_build_object('ok', false, 'code', 'REVISION_USED', 'state', j.state); end if;
    if j.delivered_at is null or j.delivered_at + make_interval(days => p_revision_window_days) < now() then
      return jsonb_build_object('ok', false, 'code', 'WINDOW_CLOSED', 'state', j.state); end if;
    v_reason := btrim(coalesce(p_payload ->> 'reason', ''));
    if char_length(v_reason) < 3 or char_length(v_reason) > 1500 then return jsonb_build_object('ok', false, 'code', 'BAD_REASON', 'state', j.state); end if;
  end if;
  if p_trigger = 'dispute_resolved_for_expert' and j.delivered_at is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_DELIVERED', 'state', j.state); end if;
  if p_trigger = 'dispute_dismissed' and j.delivered_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', j.state); end if;
  if p_to = 'delivered' then
    if p_auto_accept_at is null then return jsonb_build_object('ok', false, 'code', 'AUTO_ACCEPT_REQUIRED', 'state', j.state); end if;
    if p_delivery is null or jsonb_typeof(p_delivery) <> 'object' then return jsonb_build_object('ok', false, 'code', 'DELIVERY_REQUIRED', 'state', j.state); end if;
    select * into doc from job_documents where job_id = p_job and kind = 'working' order by version desc limit 1;
    if not found then return jsonb_build_object('ok', false, 'code', 'NOTHING_SAVED', 'state', j.state); end if;
  end if;

  -- who holds the job afterwards
  if p_to = any (carrying) then
    if (j.state = any (carrying) or j.state = 'disputed') and p_trigger <> 'reassign' then new_expert := j.expert_id;
    else new_expert := coalesce(p_expert, case when p_trigger = 'take' then p_actor end); end if;
    if new_expert is null then return jsonb_build_object('ok', false, 'code', 'EXPERT_REQUIRED', 'state', j.state); end if;
    if p_trigger in ('take', 'assign', 'reassign') then
      select * into e from expert_accounts where id = new_expert for update;
      if not found or not e.enabled or e.status not in ('probation', 'active') or not ('expert' = any (e.roles)) then
        return jsonb_build_object('ok', false, 'code', 'NOT_ELIGIBLE', 'state', j.state); end if;
      if e.totp_enabled_at is null then return jsonb_build_object('ok', false, 'code', 'TWO_FACTOR_MISSING', 'state', j.state); end if;
      if e.agreement_signed_at is null then return jsonb_build_object('ok', false, 'code', 'AGREEMENT_MISSING', 'state', j.state); end if;
      if p_trigger = 'reassign' and new_expert is not distinct from j.expert_id then
        return jsonb_build_object('ok', false, 'code', 'SAME_EXPERT', 'state', j.state); end if;
      select count(*) into active_n from human_jobs
        where expert_id = new_expert and id <> p_job and state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision');
      if active_n >= p_max_active then return jsonb_build_object('ok', false, 'code', 'CAP', 'state', j.state); end if;
    end if;
  elsif p_to in ('refunded', 'disputed') then new_expert := j.expert_id;
  else new_expert := null; end if;

  prev_state := j.state;
  claimed_now := p_to = 'claimed' and (prev_state <> 'claimed' or p_trigger = 'reassign');
  v_hours := case when (p_payload ->> 'answer_hours') ~ '^[0-9]{1,3}$' then (p_payload ->> 'answer_hours')::int else p_answer_hours end;

  begin
    if p_trigger = 'ask_question' then
      insert into job_questions (job_id, seq, body, options, answer_deadline_at)
        values (p_job, qn + 1, v_body, p_payload -> 'options', now() + make_interval(hours => v_hours));
    elsif p_trigger = 'answered' then
      update job_questions set status = 'answered', answered_at = now(), answer_body = v_answer where id = q.id;
    end if;
    if p_to = 'waiting_customer' then
      insert into job_pauses (job_id, started_at, reason, source) values (p_job, now(), 'customer_question', 'engine');
      j.pause_started_at := now();
    elsif prev_state = 'waiting_customer' then
      update job_pauses set ended_at = now() where job_id = p_job and ended_at is null
        returning greatest(0, floor(extract(epoch from (now() - started_at)))::int) into secs;
      had_open := found;
      if not had_open then secs := greatest(0, floor(extract(epoch from (now() - coalesce(j.pause_started_at, now()))))::int); end if;
      j.paused_seconds := j.paused_seconds + secs;
      if j.promised_deadline_at is not null then j.promised_deadline_at := j.promised_deadline_at + make_interval(secs => secs); end if;
      if j.internal_deadline_at is not null then j.internal_deadline_at := j.internal_deadline_at + make_interval(secs => secs); end if;
      j.pause_started_at := null;
      if p_trigger <> 'answered' then update job_questions set status = 'expired' where job_id = p_job and status = 'pending'; end if;
    end if;
    if p_trigger = 'payment_confirmed' then j.promised_deadline_at := p_promised; j.internal_deadline_at := p_internal; end if;
    update human_jobs set
      state = p_to,
      expert_id = new_expert,
      version = version + 1,
      updated_at = now(),
      paid_at = case when p_trigger = 'payment_confirmed' then now() else paid_at end,
      claimed_at = case when claimed_now then now() when p_to in ('offered', 'open') then null else claimed_at end,
      give_back_until = case when claimed_now then now() + make_interval(mins => p_give_back_minutes) when p_to in ('offered', 'open') then null else give_back_until end,
      delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
      accepted_at = case when p_to = 'accepted' then now() else accepted_at end,
      auto_accept_at = case when p_to = 'delivered' then p_auto_accept_at when p_to in ('accepted', 'refunded', 'disputed', 'revision') then null else auto_accept_at end,
      revision_count = case when p_to = 'revision' and p_trigger = 'request_revision' then revision_count + 1 else revision_count end,
      revision_requested_at = case when p_trigger = 'request_revision' then now() else revision_requested_at end,
      revision_reason = case when p_trigger = 'request_revision' then v_reason else revision_reason end,
      revision_due_at = case when p_trigger = 'request_revision' then now() + make_interval(hours => p_revision_hours) else revision_due_at end,
      score_before = case when p_to = 'delivered' then coalesce(score_before, nullif(p_delivery ->> 'score_before', '')::int) else score_before end,
      score_after = case when p_to = 'delivered' then nullif(p_delivery ->> 'score_after', '')::int else score_after end,
      paused_seconds = j.paused_seconds,
      pause_started_at = j.pause_started_at,
      promised_deadline_at = j.promised_deadline_at,
      internal_deadline_at = j.internal_deadline_at
    where id = p_job;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'code', case when p_to = 'revision' then 'REVISION_USED' else 'CONSTRAINT' end, 'state', prev_state);
  end;

  if p_to = 'delivered' then      -- the delivery rows ride in the same transaction as the state change
    ver := j.revision_count + 1;
    insert into job_documents (job_id, kind, version, body, cover_letter) values (p_job, 'delivered', ver, doc.body, doc.cover_letter) returning id into v_doc;
    insert into job_deliveries (job_id, version, document_id, score_before, score_after, report, diff, confirmation_items, change_summary, files, delivery_note)
      values (p_job, ver, v_doc, nullif(p_delivery ->> 'score_before', '')::int, nullif(p_delivery ->> 'score_after', '')::int, p_delivery -> 'report', p_delivery -> 'diff',
              coalesce(p_delivery -> 'confirmations', '[]'::jsonb), p_delivery ->> 'summary', coalesce(p_delivery -> 'files', '{}'::jsonb), p_delivery ->> 'note');
  end if;

  -- money, only here: one pay row on acceptance, one reversal when a paid job ends refunded or cancelled (a unique index is the last guard)
  if p_to = 'accepted' then
    insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
      values (new_expert, p_job, 'pay', j.expert_pay_cents, now() + make_interval(days => p_hold_days), 'accepted') on conflict do nothing;
  elsif p_to in ('refunded', 'cancelled') then
    insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
      select e2.expert_id, e2.job_id, 'reversal', -e2.amount_cents, now(), left(coalesce(p_trigger, 'refund'), 120)
      from expert_earnings e2 where e2.job_id = p_job and e2.kind = 'pay' on conflict do nothing;
  end if;

  insert into job_events (job_id, kind, actor_kind, actor_id, detail)
    values (p_job, coalesce(p_event_kind, p_trigger), p_actor_kind, p_actor,
            coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('from', prev_state, 'to', p_to, 'trigger', p_trigger)
              || case when secs > 0 then jsonb_build_object('paused_seconds', secs) else '{}'::jsonb end)
    returning id into ev;

  if p_idem_key is not null then
    insert into job_event_keys (job_id, idem_key, event_id, trigger_name, to_state) values (p_job, p_idem_key, ev, p_trigger, req_to) on conflict do nothing;
  end if;

  perform job_next_action_sync(p_job);
  select * into j from human_jobs where id = p_job;
  return jsonb_build_object('ok', true, 'replay', false, 'state', p_to, 'version', j.version, 'event_id', ev);
end $$;

do $$ declare sig text; begin
  for sig in select unnest(array[
    'human_job_transition(uuid, text, text, text, uuid, int, uuid, text, jsonb, text, int, timestamptz, int, timestamptz, timestamptz, jsonb, jsonb, int, int, int, int, int, int)',
    'job_next_action_sync(uuid)', 'human_jobs_sync_engine()']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- ---- Phase 1 functions that need to agree with the engine ----------------------------------------------------------------------------
-- (human_job_unassign already credits the wait and expires the open question since A3's 0128; the trigger above closes its pause row.)

-- a payout never includes a disputed job's earnings (engineering spec 5 and 7: a dispute freezes them)
create or replace function expert_record_payout(p_expert uuid, p_method text, p_reference text, p_key text, p_min_cents int, p_note text default null)
returns jsonb language plpgsql as $$
declare existing expert_payouts; total int; pid uuid;
begin
  select * into existing from expert_payouts where idempotency_key = p_key;
  if found then return jsonb_build_object('ok', true, 'already', true, 'payout_id', existing.id, 'amount_cents', existing.amount_cents); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_expert::text, 0));
  select coalesce(sum(e.amount_cents), 0) into total from expert_earnings e
    where e.expert_id = p_expert and e.payout_id is null and e.release_at <= now()
      and not exists (select 1 from human_jobs h where h.id = e.job_id and h.state = 'disputed');
  if total < greatest(p_min_cents, 1) then return jsonb_build_object('ok', false, 'reason', 'below_minimum', 'available_cents', total); end if;
  insert into expert_payouts (expert_id, amount_cents, method, reference, idempotency_key, note) values (p_expert, total, p_method, p_reference, p_key, p_note) returning id into pid;
  update expert_earnings e set payout_id = pid
    where e.expert_id = p_expert and e.payout_id is null and e.release_at <= now()
      and not exists (select 1 from human_jobs h where h.id = e.job_id and h.state = 'disputed');
  return jsonb_build_object('ok', true, 'already', false, 'payout_id', pid, 'amount_cents', total);
end $$;

-- ---- repair of what 0127's backfill (and Phase 1 since) left behind -----------------------------------------------------------------
-- Rebuild the backfilled pauses: a question ends at the next answer, expiry OR release of the job (an unassign ends the wait too).
delete from job_pauses where source = 'phase1_backfill';
insert into job_pauses (job_id, started_at, ended_at, reason, source)
select s.job_id, s.created_at,
       (select min(r.created_at) from job_events r where r.job_id = s.job_id and r.id > s.id and r.kind in ('question_answered', 'question_expired', 'released')),
       'customer_question', 'phase1_backfill'
from job_events s where s.kind = 'question_asked'
on conflict do nothing;
-- a pause still open on a job that is not waiting is stale: close it where the job last changed
update job_pauses p set ended_at = greatest(p.started_at, h.updated_at) from human_jobs h
  where h.id = p.job_id and p.ended_at is null and h.state <> 'waiting_customer';
-- a job that IS waiting has an open pause
insert into job_pauses (job_id, started_at, reason, source)
select h.id, h.pause_started_at, 'customer_question', 'phase1_backfill' from human_jobs h
  where h.state = 'waiting_customer' and h.pause_started_at is not null
    and not exists (select 1 from job_pauses p where p.job_id = h.id and p.ended_at is null)
on conflict do nothing;
select job_next_action_sync(id) from human_jobs;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (129, '0129_experts_engine_audit_a4')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 129, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 129;   -- never move the version BACKWARDS (a re-run of an older file)
