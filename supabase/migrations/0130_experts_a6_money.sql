-- 0130: Experts audit A6 (money): the ledger's last holes.
--   * human_job_accept / auto-accept / the 2A transition refuse to pay an expert unless the payment is SUCCESS (a refunded or disputed payment never earns)
--   * a reversal is released with the pay row it cancels, so the two net together
--   * human_job_reverse takes an optional expected-state list (the customer cancel can no longer refund a job an expert just took)
--   * expert_record_payout: key checked AFTER the expert lock, bound to the expert, stamped from the exact id set it summed, and earnings of a DISPUTED payment are frozen out
--   * new: expert_record_adjustment (bonus / tier_bonus / penalty / adjustment), expert_void_payout, expert_balances (set-based, no row cap), human_job_add_late_credit
alter table expert_earnings add column if not exists idempotency_key text;
alter table expert_earnings add column if not exists created_by      text;
create unique index if not exists expert_earnings_idem_key on expert_earnings (idempotency_key) where idempotency_key is not null;
alter table expert_payouts add column if not exists voided_at   timestamptz;
alter table expert_payouts add column if not exists voided_by   text;
alter table expert_payouts add column if not exists void_reason text;

-- B7: a reversal is released exactly when the pay row it cancels is (both held, or both free), so a payout run never sees one without the other.
create or replace function expert_earnings_reversal_release() returns trigger language plpgsql as $$
declare pr timestamptz;
begin
  if new.kind = 'reversal' and new.job_id is not null then
    select release_at into pr from expert_earnings where job_id = new.job_id and kind = 'pay';
    if pr is not null then new.release_at := pr; end if;
  end if;
  return new;
end $$;
drop trigger if exists expert_earnings_reversal_release_trg on expert_earnings;
create trigger expert_earnings_reversal_release_trg before insert on expert_earnings for each row execute function expert_earnings_reversal_release();

-- B2, last guard (covers the Phase 2A transition function too): a job cannot become accepted unless its payment is SUCCESS.
create or replace function human_jobs_accept_needs_settled_payment() returns trigger language plpgsql as $$
begin
  if new.state = 'accepted' and old.state is distinct from 'accepted'
     and not exists (select 1 from payments p where p.id = new.payment_id and p.status = 'SUCCESS') then
    raise exception 'payment is not settled' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists human_jobs_accept_needs_settled_payment_trg on human_jobs;
create trigger human_jobs_accept_needs_settled_payment_trg before update of state on human_jobs for each row execute function human_jobs_accept_needs_settled_payment();

create or replace function human_job_accept(p_job uuid, p_actor_kind text, p_actor uuid, p_hold_days int default 3)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state = 'accepted' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.state <> 'delivered' then return jsonb_build_object('ok', false, 'reason', 'not_delivered', 'state', j.state); end if;
  if not exists (select 1 from payments p where p.id = j.payment_id and p.status = 'SUCCESS') then
    return jsonb_build_object('ok', false, 'reason', 'payment_not_settled');
  end if;
  update human_jobs set state = 'accepted', accepted_at = now(), auto_accept_at = null, version = version + 1, updated_at = now() where id = p_job;
  insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
    values (j.expert_id, p_job, 'pay', j.expert_pay_cents, now() + make_interval(days => p_hold_days), 'accepted')
    on conflict do nothing;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'accepted', p_actor_kind, p_actor, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- the sweep only picks jobs it can accept, so a blocked (disputed / refunded-payment) job can never starve the 200-row batch
create or replace function human_job_auto_accept_due(p_hold_days int)
returns int language plpgsql as $$
declare r record; n int := 0; res jsonb;
begin
  for r in select h.id from human_jobs h join payments p on p.id = h.payment_id
           where h.state = 'delivered' and h.auto_accept_at is not null and h.auto_accept_at <= now() and p.status = 'SUCCESS'
           order by h.auto_accept_at limit 200 loop
    res := human_job_accept(r.id, 'system', null, p_hold_days);
    if (res->>'ok')::boolean and not coalesce((res->>'already')::boolean, false) then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- B4: optional expected states. The old two-argument signature is dropped (a default-argument overload would be ambiguous).
drop function if exists human_job_reverse(uuid, text);
create or replace function human_job_reverse(p_job uuid, p_reason text, p_only_states text[] default null)
returns jsonb language plpgsql as $$
declare j human_jobs; target text;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state in ('refunded', 'cancelled') then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_only_states is not null and not (j.state = any (p_only_states)) then
    return jsonb_build_object('ok', false, 'reason', 'state_changed', 'state', j.state);
  end if;
  target := case when j.state in ('awaiting_payment', 'offered', 'open') then 'cancelled' else 'refunded' end;
  update human_jobs set state = target, expert_id = case when target = 'cancelled' then null else expert_id end,
         version = version + 1, updated_at = now() where id = p_job;
  insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
    select e.expert_id, e.job_id, 'reversal', -e.amount_cents, now(), left(coalesce(p_reason, 'refund'), 120)
    from expert_earnings e where e.job_id = p_job and e.kind = 'pay'
    on conflict do nothing;
  insert into job_events (job_id, kind, actor_kind, detail) values (p_job, case when target = 'cancelled' then 'cancelled' else 'refunded' end, 'system', jsonb_build_object('reason', left(coalesce(p_reason, ''), 120)));
  return jsonb_build_object('ok', true, 'already', false, 'state', target);
end $$;

-- (0129 already froze a job in state 'disputed' out of the payout; this keeps that and adds a DISPUTED payment, the chargeback case.)
-- B3 + G4: lock first, then the key check (bound to the expert); the ids it sums are the ids it stamps; DISPUTED-payment pay rows are frozen out.
create or replace function expert_record_payout(p_expert uuid, p_method text, p_reference text, p_key text, p_min_cents int, p_note text default null)
returns jsonb language plpgsql as $$
declare existing expert_payouts; total int; ids uuid[]; pid uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_expert::text, 0));
  select * into existing from expert_payouts where idempotency_key = p_key;
  if found then
    if existing.expert_id <> p_expert then return jsonb_build_object('ok', false, 'reason', 'key_conflict'); end if;
    return jsonb_build_object('ok', true, 'already', true, 'payout_id', existing.id, 'amount_cents', existing.amount_cents);
  end if;
  select coalesce(sum(e.amount_cents), 0), array_agg(e.id) into total, ids
    from expert_earnings e
   where e.expert_id = p_expert and e.payout_id is null and e.release_at <= now()
     and not exists (select 1 from human_jobs h join payments p on p.id = h.payment_id where h.id = e.job_id and (h.state = 'disputed' or (e.kind = 'pay' and p.status = 'DISPUTED')));
  if total < greatest(p_min_cents, 1) then return jsonb_build_object('ok', false, 'reason', 'below_minimum', 'available_cents', total); end if;
  begin
    insert into expert_payouts (expert_id, amount_cents, method, reference, idempotency_key, note) values (p_expert, total, p_method, p_reference, p_key, p_note) returning id into pid;
  exception when unique_violation then
    select * into existing from expert_payouts where idempotency_key = p_key;
    if found and existing.expert_id = p_expert then return jsonb_build_object('ok', true, 'already', true, 'payout_id', existing.id, 'amount_cents', existing.amount_cents); end if;
    return jsonb_build_object('ok', false, 'reason', 'key_conflict');
  end;
  update expert_earnings set payout_id = pid where id = any (ids);
  return jsonb_build_object('ok', true, 'already', false, 'payout_id', pid, 'amount_cents', total);
end $$;

-- G3: manual ledger rows. Signs are enforced (a bonus is never negative, a penalty never positive); a reason and a key are required; every row names who made it.
create or replace function expert_record_adjustment(p_expert uuid, p_kind text, p_amount int, p_job uuid, p_reason text, p_key text, p_actor text default null, p_hold_days int default 0)
returns jsonb language plpgsql as $$
declare existing expert_earnings; eid uuid;
begin
  if p_kind not in ('bonus', 'tier_bonus', 'penalty', 'adjustment') then return jsonb_build_object('ok', false, 'reason', 'bad_kind'); end if;
  if p_amount is null or p_amount = 0 or (p_kind in ('bonus', 'tier_bonus') and p_amount < 0) or (p_kind = 'penalty' and p_amount > 0) then
    return jsonb_build_object('ok', false, 'reason', 'bad_amount');
  end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  if p_key is null or length(p_key) < 8 then return jsonb_build_object('ok', false, 'reason', 'bad_key'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_expert::text, 0));
  select * into existing from expert_earnings where idempotency_key = p_key;
  if found then
    if existing.expert_id <> p_expert or existing.amount_cents <> p_amount or existing.kind <> p_kind then return jsonb_build_object('ok', false, 'reason', 'key_conflict'); end if;
    return jsonb_build_object('ok', true, 'already', true, 'earning_id', existing.id);
  end if;
  if not exists (select 1 from expert_accounts where id = p_expert) then return jsonb_build_object('ok', false, 'reason', 'no_expert'); end if;
  if p_job is not null and not exists (select 1 from human_jobs h where h.id = p_job and h.expert_id = p_expert) then return jsonb_build_object('ok', false, 'reason', 'job_mismatch'); end if;
  insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason, idempotency_key, created_by)
    values (p_expert, p_job, p_kind, p_amount, now() + make_interval(days => greatest(coalesce(p_hold_days, 0), 0)), left(btrim(p_reason), 200), p_key, left(p_actor, 80))
    returning id into eid;
  return jsonb_build_object('ok', true, 'already', false, 'earning_id', eid);
end $$;

-- G3: undo a payout recorded by mistake. The rows go back to the available pool; the payout stays on file, marked void, and its key stays used.
create or replace function expert_void_payout(p_payout uuid, p_reason text, p_actor text default null)
returns jsonb language plpgsql as $$
declare po expert_payouts; restored int;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;
  select * into po from expert_payouts where id = p_payout;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(po.expert_id::text, 0));
  select * into po from expert_payouts where id = p_payout for update;
  if po.voided_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update expert_payouts set voided_at = now(), void_reason = left(btrim(p_reason), 200), voided_by = left(p_actor, 80) where id = p_payout;
  update expert_earnings set payout_id = null where payout_id = p_payout;
  get diagnostics restored = row_count;
  return jsonb_build_object('ok', true, 'already', false, 'amount_cents', po.amount_cents, 'rows_restored', restored);
end $$;

-- G5 + G4 + G2: per-expert balances computed in the database (no 1000-row read cap). frozen = rows of a job in state 'disputed' and pay rows of a DISPUTED payment.
create or replace function expert_balances(p_expert uuid default null)
returns table (expert_id uuid, available_cents bigint, held_cents bigint, frozen_cents bigint, paid_cents bigint)
language sql stable as $$
  with x as (
    select e.expert_id, e.amount_cents, e.payout_id, e.release_at,
           exists (select 1 from human_jobs h join payments p on p.id = h.payment_id where h.id = e.job_id and (h.state = 'disputed' or (e.kind = 'pay' and p.status = 'DISPUTED'))) as frozen
      from expert_earnings e where p_expert is null or e.expert_id = p_expert)
  select x.expert_id,
         coalesce(sum(x.amount_cents) filter (where x.payout_id is null and x.release_at <= now() and not x.frozen), 0)::bigint,
         coalesce(sum(x.amount_cents) filter (where x.payout_id is null and x.release_at >  now() and not x.frozen), 0)::bigint,
         coalesce(sum(x.amount_cents) filter (where x.payout_id is null and x.frozen), 0)::bigint,
         coalesce(sum(x.amount_cents) filter (where x.payout_id is not null), 0)::bigint
    from x group by x.expert_id
$$;

-- G3: a late credit is real money back to the customer, so the recorded figure can only grow through this function and always below the price (the whole price is a refund).
create or replace function human_job_add_late_credit(p_job uuid, p_cents int)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  if p_cents is null or p_cents <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_amount'); end if;
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.paid_at is null or j.state in ('awaiting_payment', 'cancelled', 'refunded') then return jsonb_build_object('ok', false, 'reason', 'not_credit_eligible', 'state', j.state); end if;
  if j.late_credit_cents + p_cents >= j.price_cents then return jsonb_build_object('ok', false, 'reason', 'over_price', 'late_credit_cents', j.late_credit_cents); end if;
  update human_jobs set late_credit_cents = late_credit_cents + p_cents, updated_at = now() where id = p_job;
  return jsonb_build_object('ok', true, 'late_credit_cents', j.late_credit_cents + p_cents);
end $$;

do $$ declare sig text; begin
  for sig in select unnest(array[
    'human_job_accept(uuid, text, uuid, int)', 'human_job_auto_accept_due(int)', 'human_job_reverse(uuid, text, text[])',
    'expert_record_payout(uuid, text, text, text, int, text)', 'expert_record_adjustment(uuid, text, int, uuid, text, text, text, int)',
    'expert_void_payout(uuid, text, text)', 'expert_balances(uuid)', 'human_job_add_late_credit(uuid, int)']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (130, '0130_experts_a6_money')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 130, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 130;   -- never move the version BACKWARDS (a re-run of an older file)
