-- Passthrough Experts, Phase 2A: the expert realm (sessions, recovery codes, password reset) and the job engine
-- (the transition rules, pauses, next actions, event idempotency, the bridge ledger, and ONE transition function).
--
-- ADDITIVE ONLY. Nothing that exists is altered, dropped or renamed: no column, constraint, index, function or row of any earlier
-- migration is touched. Every new table has row level security ON with no policy and no grant to anon / authenticated (the Worker's
-- service role is the only reader/writer, as everywhere else here). Every new function has execute revoked from public, anon and
-- authenticated; only the service role may call it.
--
-- New tables: expert_sessions, expert_recovery_codes, expert_password_resets, job_transition_rules, job_next_actions, job_pauses,
--             job_event_keys, expert_bridge_calls.
-- New function: human_job_transition (the database half of the state machine; the JavaScript half is services/humanJobs.service.js).
-- Data: seeds job_transition_rules, then a REVERSIBLE backfill of the Phase 1 pilot jobs into job_next_actions and job_pauses
--       (every backfilled row has source = 'phase1_backfill'; delete those rows to undo it. See docs/experts/phase2a/rollback-0127.sql).
--
-- Phase 1's own functions (human_job_*) are NOT replaced. They keep working while EXPERTS_ENABLED is on; the realm's callers use
-- human_job_transition. See CHANGES-experts-phase-2a.txt, "Known gaps", for the Phase 1 callers that do not go through it yet.

-- ---- expert_sessions: server-side sessions for the expert realm (8 hours idle, 7 days absolute; both read from settings) -------
create table if not exists expert_sessions (
  id                   uuid primary key default gen_random_uuid(),
  expert_id            uuid not null references expert_accounts(id) on delete cascade,
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  absolute_expires_at  timestamptz not null,
  mfa_verified_at      timestamptz,                       -- null = password checked, second factor still to do (a pending session)
  elevated_until       timestamptz,                       -- step-up: a fresh password check lifts this a few minutes
  revoked_at           timestamptz,
  revoked_reason       text check (revoked_reason is null or char_length(revoked_reason) <= 60),
  ip_hash              text check (ip_hash is null or char_length(ip_hash) <= 64),
  user_agent           text check (user_agent is null or char_length(user_agent) <= 200)
);
create index if not exists expert_sessions_expert_idx on expert_sessions (expert_id, revoked_at);
alter table expert_sessions enable row level security;
revoke all on expert_sessions from anon, authenticated;

-- ---- expert_recovery_codes: ten single-use codes per account, stored only as keyed hashes --------------------------------------
create table if not exists expert_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  expert_id   uuid not null references expert_accounts(id) on delete cascade,
  code_hash   text not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  unique (expert_id, code_hash)
);
alter table expert_recovery_codes enable row level security;
revoke all on expert_recovery_codes from anon, authenticated;

-- ---- expert_password_resets: one-time reset links; only a hash of the token is kept ---------------------------------------------
create table if not exists expert_password_resets (
  id                uuid primary key default gen_random_uuid(),
  expert_id         uuid not null references expert_accounts(id) on delete cascade,
  token_hash        text not null unique,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  requested_ip_hash text check (requested_ip_hash is null or char_length(requested_ip_hash) <= 64)
);
create index if not exists expert_password_resets_expert_idx on expert_password_resets (expert_id, created_at);
alter table expert_password_resets enable row level security;
revoke all on expert_password_resets from anon, authenticated;

-- ---- job_transition_rules: the legal moves (engineering spec section 5), enforced by human_job_transition -----------------------
-- actors are the job_events actor kinds: system, expert, customer, operator. A grader acts as 'expert' in events (detail carries role).
create table if not exists job_transition_rules (
  from_state  text not null,
  to_state    text not null,
  trigger     text not null,
  actors      text[] not null check (cardinality(actors) >= 1 and actors <@ array['system', 'expert', 'customer', 'operator']),
  primary key (from_state, to_state, trigger)
);
alter table job_transition_rules enable row level security;
revoke all on job_transition_rules from anon, authenticated;

insert into job_transition_rules (from_state, to_state, trigger, actors) values
  ('awaiting_payment', 'offered',    'payment_confirmed',  array['system']),
  ('awaiting_payment', 'cancelled',  'expired',            array['system']),
  ('awaiting_payment', 'cancelled',  'customer_cancel',    array['customer']),
  ('awaiting_payment', 'cancelled',  'admin_cancel',       array['operator']),
  ('offered',          'cancelled',  'customer_cancel',    array['customer']),
  ('offered',          'cancelled',  'admin_cancel',       array['operator']),
  ('offered',          'cancelled',  'payment_reversed',   array['system']),
  ('open',             'cancelled',  'customer_cancel',    array['customer']),
  ('open',             'cancelled',  'admin_cancel',       array['operator']),
  ('open',             'cancelled',  'payment_reversed',   array['system']),
  ('offered',          'open',       'cascade_widen',      array['system']),
  ('offered',          'claimed',    'take',               array['expert']),
  ('open',             'claimed',    'take',               array['expert']),
  ('offered',          'claimed',    'assign',             array['operator']),
  ('open',             'claimed',    'assign',             array['operator']),
  ('claimed',          'offered',    'give_back_in_window', array['expert']),
  ('claimed',          'open',       'give_back_in_window', array['expert']),
  ('claimed',          'open',       'give_back_late',     array['expert']),
  ('in_progress',      'open',       'give_back_late',     array['expert']),
  ('claimed',          'open',       'auto_release',       array['system']),
  ('in_progress',      'open',       'auto_release',       array['system']),
  ('claimed',          'open',       'unassign',           array['operator']),
  ('in_progress',      'open',       'unassign',           array['operator']),
  ('claimed',          'claimed',    'reassign',           array['operator']),
  ('in_progress',      'claimed',    'reassign',           array['operator']),
  ('waiting_customer', 'claimed',    'reassign',           array['operator']),
  ('claimed',          'in_progress', 'first_save',        array['expert']),
  ('in_progress',      'waiting_customer', 'ask_question', array['expert']),
  ('waiting_customer', 'in_progress', 'answered',          array['customer']),
  ('waiting_customer', 'in_progress', 'question_timeout',  array['system']),
  ('in_progress',      'in_review',  'submit_review',      array['expert']),
  ('revision',         'in_review',  'submit_review',      array['expert']),
  ('in_progress',      'final_checks', 'deliver',          array['expert']),
  ('in_review',        'final_checks', 'review_approved',  array['operator']),
  ('in_review',        'in_progress', 'sent_back',         array['operator']),
  ('final_checks',     'delivered',  'rescan_passed',      array['system']),
  ('final_checks',     'in_progress', 'rescan_failed',     array['system']),
  ('delivered',        'accepted',   'accept',             array['customer']),
  ('delivered',        'accepted',   'auto_accept',        array['system']),
  ('delivered',        'revision',   'request_revision',   array['customer']),
  ('revision',         'delivered',  'redeliver',          array['expert']),
  ('claimed',          'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('in_progress',      'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('waiting_customer', 'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('in_review',        'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('final_checks',     'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('delivered',        'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('revision',         'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('accepted',         'disputed',   'dispute',            array['customer', 'expert', 'operator']),
  ('claimed',          'refunded',   'refund',             array['operator', 'system']),
  ('in_progress',      'refunded',   'refund',             array['operator', 'system']),
  ('waiting_customer', 'refunded',   'refund',             array['operator', 'system']),
  ('in_review',        'refunded',   'refund',             array['operator', 'system']),
  ('final_checks',     'refunded',   'refund',             array['operator', 'system']),
  ('delivered',        'refunded',   'refund',             array['operator', 'system']),
  ('revision',         'refunded',   'refund',             array['operator', 'system']),
  ('accepted',         'refunded',   'refund',             array['operator', 'system']),
  ('disputed',         'refunded',   'refund',             array['operator', 'system'])
on conflict do nothing;

-- ---- job_next_actions: the scheduler's one trigger per job, kept beside the job (human_jobs itself is not altered) -------------
create table if not exists job_next_actions (
  job_id           uuid primary key references human_jobs(id) on delete cascade,
  next_action_at   timestamptz not null,
  next_action_kind text not null check (char_length(next_action_kind) between 1 and 60),
  updated_at       timestamptz not null default now(),
  source           text not null default 'engine' check (source in ('engine', 'phase1_backfill'))
);
create index if not exists job_next_actions_due_idx on job_next_actions (next_action_at);
alter table job_next_actions enable row level security;
revoke all on job_next_actions from anon, authenticated;

-- ---- job_pauses: explicit clock-pause intervals (customer questions). At most one open pause per job. ---------------------------
create table if not exists job_pauses (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references human_jobs(id) on delete cascade,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  reason      text not null default 'customer_question' check (reason in ('customer_question')),
  source      text not null default 'engine' check (source in ('engine', 'phase1_backfill')),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists job_pauses_job_idx on job_pauses (job_id, started_at);
create unique index if not exists job_pauses_one_open_per_job on job_pauses (job_id) where ended_at is null;
alter table job_pauses enable row level security;
revoke all on job_pauses from anon, authenticated;

-- ---- job_event_keys: an idempotency key makes a repeated transition a no-op that reports the original outcome -----------------
create table if not exists job_event_keys (
  job_id     uuid not null references human_jobs(id) on delete cascade,
  idem_key   text not null check (char_length(idem_key) between 1 and 120),
  event_id   bigint,
  created_at timestamptz not null default now(),
  primary key (job_id, idem_key)
);
alter table job_event_keys enable row level security;
revoke all on job_event_keys from anon, authenticated;

-- ---- expert_bridge_calls: one row per bridge call (who asked, why, what happened); a repeated key cannot act twice -------------
create table if not exists expert_bridge_calls (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  fn          text not null check (fn in ('refund_human_order', 'read_human_order_payment', 'create_job_from_payment')),
  job_id      uuid references human_jobs(id) on delete set null,
  actor_id    uuid references expert_accounts(id) on delete set null,
  idem_key    text check (idem_key is null or char_length(idem_key) <= 120),
  amount_cents int check (amount_cents is null or amount_cents > 0),
  reason      text check (reason is null or char_length(reason) <= 300),
  outcome     text not null default 'started' check (outcome in ('started', 'ok', 'refused', 'failed')),
  code        text check (code is null or char_length(code) <= 60)
);
create index if not exists expert_bridge_calls_job_idx on expert_bridge_calls (job_id);
create index if not exists expert_bridge_calls_actor_idx on expert_bridge_calls (actor_id);
create unique index if not exists expert_bridge_calls_once_per_key on expert_bridge_calls (fn, idem_key) where idem_key is not null;
alter table expert_bridge_calls enable row level security;
revoke all on expert_bridge_calls from anon, authenticated;

-- ---- human_job_transition: the only function that moves a job between states -----------------------------------------------------
-- It checks the rule table, the actor, who owns what, and the version (compare-and-set); applies the state change and its side effects
-- (expert set or cleared, pause interval opened or closed with both deadlines pushed back by the time paused, pay row on acceptance,
-- reversal row on refund); writes the job event; records the idempotency key; and sets or clears the next action. All in one transaction.
-- It never reads or writes resume text. Returns {ok, code?, state?, version?, event_id?, replay?}.
create or replace function human_job_transition(
  p_job uuid, p_to text, p_trigger text, p_actor_kind text, p_actor uuid,
  p_expected_version int default null, p_expert uuid default null,
  p_event_kind text default null, p_detail jsonb default '{}'::jsonb, p_idem_key text default null,
  p_hold_days int default 3, p_auto_accept_at timestamptz default null, p_max_active int default 2,
  p_promised timestamptz default null, p_internal timestamptz default null     -- only read on payment_confirmed (deadlines are computed from settings by the caller)
) returns jsonb language plpgsql as $$
declare
  j human_jobs; e expert_accounts; r job_transition_rules;
  carrying constant text[] := array['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted'];
  new_expert uuid; secs int := 0; ev bigint; na timestamptz; nk text; active_n int; prev_state text; had_open boolean := false;
begin
  if p_idem_key is not null then
    perform 1 from job_event_keys where job_id = p_job and idem_key = p_idem_key;
    if found then
      select * into j from human_jobs where id = p_job;
      return jsonb_build_object('ok', true, 'replay', true, 'state', j.state, 'version', j.version);
    end if;
  end if;

  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;

  if p_idem_key is not null then      -- a second caller with the same key that waited on the lock above
    perform 1 from job_event_keys where job_id = p_job and idem_key = p_idem_key;
    if found then return jsonb_build_object('ok', true, 'replay', true, 'state', j.state, 'version', j.version); end if;
  end if;

  if p_expected_version is not null and j.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'VERSION_CONFLICT', 'state', j.state, 'version', j.version);
  end if;

  select * into r from job_transition_rules where from_state = j.state and to_state = p_to and trigger = p_trigger;
  if not found or not (p_actor_kind = any (r.actors)) then
    return jsonb_build_object('ok', false, 'code', 'ILLEGAL_TRANSITION', 'state', j.state);
  end if;

  if p_actor_kind = 'expert' and p_trigger <> 'take' and j.expert_id is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'NOT_ASSIGNED', 'state', j.state);
  end if;
  if p_actor_kind = 'customer' and j.customer_user_id is distinct from p_actor then
    return jsonb_build_object('ok', false, 'code', 'NOT_OWNER', 'state', j.state);
  end if;

  -- who holds the job afterwards
  if p_to = any (carrying) then
    if j.state = any (carrying) and p_trigger <> 'reassign' then new_expert := j.expert_id;
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

  begin
    -- clock: opening and closing a pause. Both deadlines move back by the time spent paused (the same rule Phase 1 applies).
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
    end if;
    if p_trigger = 'payment_confirmed' then j.promised_deadline_at := p_promised; j.internal_deadline_at := p_internal; end if;
    update human_jobs set
      state = p_to,
      expert_id = new_expert,
      version = version + 1,
      updated_at = now(),
      paid_at = case when p_trigger = 'payment_confirmed' then now() else paid_at end,
      claimed_at = case when p_to = 'claimed' and (prev_state <> 'claimed' or p_trigger = 'reassign') then now() else claimed_at end,
      delivered_at = case when p_to = 'delivered' then now() else delivered_at end,
      accepted_at = case when p_to = 'accepted' then now() else accepted_at end,
      auto_accept_at = case when p_to = 'delivered' then p_auto_accept_at when p_to in ('accepted', 'refunded', 'disputed') then null else auto_accept_at end,
      revision_count = case when p_to = 'revision' then revision_count + 1 else revision_count end,
      revision_requested_at = case when p_to = 'revision' then now() else revision_requested_at end,
      paused_seconds = j.paused_seconds,
      pause_started_at = j.pause_started_at,
      promised_deadline_at = j.promised_deadline_at,
      internal_deadline_at = j.internal_deadline_at
    where id = p_job;
  exception when check_violation then
    return jsonb_build_object('ok', false, 'code', case when p_to = 'revision' then 'REVISION_USED' else 'CONSTRAINT' end, 'state', prev_state);
  end;

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
    insert into job_event_keys (job_id, idem_key, event_id) values (p_job, p_idem_key, ev) on conflict do nothing;
  end if;

  -- the one thing this job now waits for (the same rule as nextActionFor in lib/expertRealm/stateMachine.js; a test keeps them equal)
  select * into j from human_jobs where id = p_job;
  na := null; nk := null;
  if p_to in ('claimed', 'in_progress', 'revision') then na := j.internal_deadline_at; nk := 'deadline_warning';
  elsif p_to = 'waiting_customer' then
    select q.answer_deadline_at into na from job_questions q where q.job_id = p_job and q.status = 'pending' order by q.seq desc limit 1;
    nk := 'question_timeout';
  elsif p_to = 'delivered' then na := j.auto_accept_at; nk := 'auto_accept'; end if;
  if na is not null and nk is not null then
    insert into job_next_actions (job_id, next_action_at, next_action_kind, source) values (p_job, na, nk, 'engine')
      on conflict (job_id) do update set next_action_at = excluded.next_action_at, next_action_kind = excluded.next_action_kind, updated_at = now(), source = 'engine';
  else
    delete from job_next_actions where job_id = p_job;
  end if;

  return jsonb_build_object('ok', true, 'replay', false, 'state', p_to, 'version', j.version, 'event_id', ev);
end $$;

do $$ declare sig text; begin
  for sig in select unnest(array[
    'human_job_transition(uuid, text, text, text, uuid, int, uuid, text, jsonb, text, int, timestamptz, int, timestamptz, timestamptz)']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- ---- reversible backfill of the Phase 1 pilot jobs ------------------------------------------------------------------------------
-- Pauses: every question_asked event is paired with the next question_answered / question_expired event of the same job; a question still
-- open becomes an open pause. Next actions: what the Phase 1 hourly sweep acts on, kept where the engine reads it.
-- Nothing in human_jobs, job_events or job_questions is changed. To undo: delete from job_pauses / job_next_actions where source = 'phase1_backfill'.
insert into job_pauses (job_id, started_at, ended_at, reason, source)
select s.job_id, s.created_at,
       (select min(r.created_at) from job_events r where r.job_id = s.job_id and r.id > s.id and r.kind in ('question_answered', 'question_expired')),
       'customer_question', 'phase1_backfill'
from job_events s
where s.kind = 'question_asked'
  and not exists (select 1 from job_pauses p where p.job_id = s.job_id and p.started_at = s.created_at)
on conflict do nothing;

insert into job_next_actions (job_id, next_action_at, next_action_kind, source)
select h.id,
       case h.state
         when 'delivered'        then h.auto_accept_at
         when 'waiting_customer' then (select q.answer_deadline_at from job_questions q where q.job_id = h.id and q.status = 'pending' order by q.seq desc limit 1)
         when 'awaiting_payment' then h.created_at + interval '24 hours'
         else h.internal_deadline_at end,
       case h.state
         when 'delivered'        then 'auto_accept'
         when 'waiting_customer' then 'question_timeout'
         when 'awaiting_payment' then 'expire_unpaid'
         else 'deadline_warning' end,
       'phase1_backfill'
from human_jobs h
where h.state in ('awaiting_payment', 'offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision')
  and case h.state
        when 'delivered'        then h.auto_accept_at
        when 'waiting_customer' then (select q.answer_deadline_at from job_questions q where q.job_id = h.id and q.status = 'pending' order by q.seq desc limit 1)
        when 'awaiting_payment' then h.created_at
        else h.internal_deadline_at end is not null
on conflict (job_id) do nothing;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (127, '0127_experts_phase2a_realm')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 127, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 127;   -- never move the version BACKWARDS (a re-run of an older file)
