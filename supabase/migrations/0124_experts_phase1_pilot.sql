-- Passthrough Experts, Phase 1: the concierge pilot (a human dispatches; hand-created expert accounts).
--
-- ADDITIVE ONLY. Nothing that exists is altered except ONE nullable column on payments (product_kind) that no existing row or
-- code path reads. Every new table has row level security ON with no policy and no grant to anon / authenticated (the Worker's
-- service role is the only reader/writer, as everywhere else here). Every new function has execute revoked from public, anon and
-- authenticated: only the service role may call them.
--
-- Tables (engineering spec section 19, Phase 1 list, plus the three the pilot cannot run without; see CHANGES-experts-phase-1.txt):
--   expert_accounts, human_jobs, job_events, job_documents, job_locked_values, job_deliveries, job_questions, job_materials,
--   expert_earnings, expert_payouts (minimal, manual payouts), expert_audit_log (every expert / staff read of client content).
-- Settings live in system_state (key 'human_pilot'): the app has no other settings table (the promo config uses the same table).
--
-- The database is where "an expert can read a client's content only for a job currently assigned to them" is enforced:
-- the only way the Worker reads or writes job content for an expert is human_job_expert_read / human_job_expert_save below, and
-- both refuse (and log the attempt) unless the job is assigned to that expert and in a working state.

-- ── payments: which kind of product this payment bought ────────────────────────────────────────────────────────────────────
alter table payments add column if not exists product_kind text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_product_kind_check') then
    alter table payments add constraint payments_product_kind_check
      check (product_kind is null or product_kind in ('human_polish', 'human_seven_day', 'human_forty_eight_hour', 'human_twenty_four_hour'));
  end if;
end $$;

-- ── expert_accounts ────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists expert_accounts (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null unique check (email = lower(email)),
  password_hash         text not null,
  roles                 text[] not null default array['expert'] check (cardinality(roles) >= 1 and roles <@ array['expert', 'grader', 'expert_admin', 'expert_support']),
  status                text not null default 'active' check (status in ('invited', 'applicant', 'probation', 'active', 'paused', 'under_review', 'ended')),
  enabled               boolean not null default false,            -- the per-expert switch (engineering spec 19): off until the operator turns it on
  display_first_name    text not null,
  display_initial       text not null check (char_length(display_initial) between 1 and 2),
  totp_secret_enc       text,
  totp_enabled_at       timestamptz,
  totp_last_step        bigint,                                    -- last accepted time step: a code cannot be replayed
  token_version         int not null default 0,
  agreement_version     text,
  agreement_signed_at   timestamptz,
  failed_logins         int not null default 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter table expert_accounts enable row level security;
revoke all on expert_accounts from anon, authenticated;

-- ── human_jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists human_jobs (
  id                    uuid primary key default gen_random_uuid(),
  job_number            text not null unique,
  payment_id            uuid not null unique references payments(id),   -- one job per payment, ever: the idempotency guard
  customer_user_id      uuid not null references users(id),
  scan_id               uuid references scans(id) on delete set null,
  tier                  text not null check (tier in ('polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour')),
  add_cover_letter      boolean not null default false,
  tier_price_cents      int not null check (tier_price_cents > 0),
  cover_price_cents     int not null default 0 check (cover_price_cents >= 0),
  price_cents           int not null check (price_cents > 0),            -- total charged, snapshot at checkout
  expert_pay_cents      int not null check (expert_pay_cents >= 0),      -- total pay, snapshot at checkout; never edited
  currency              text not null default 'USD',
  state                 text not null default 'awaiting_payment' check (state in (
                          'awaiting_payment', 'offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review',
                          'final_checks', 'delivered', 'revision', 'accepted', 'disputed', 'refunded', 'cancelled')),
  version               int not null default 0,
  expert_id             uuid references expert_accounts(id),
  brief                 jsonb not null default '{}'::jsonb,
  customer_region       text,
  -- consents recorded at checkout (product spec 6.2)
  terms_consent_at      timestamptz not null,
  terms_version         text,
  age_attested          boolean not null check (age_attested),
  rights_attested       boolean not null check (rights_attested),
  learning_consent      boolean not null default false,
  review_required       boolean not null default true,                   -- the founder reviews every delivery in the pilot (Appendix F.3)
  paid_at               timestamptz,
  promised_deadline_at  timestamptz,
  internal_deadline_at  timestamptz,
  paused_seconds        int not null default 0,
  pause_started_at      timestamptz,
  claimed_at            timestamptz,
  delivered_at          timestamptz,
  accepted_at           timestamptz,
  auto_accept_at        timestamptz,
  revision_count        smallint not null default 0 check (revision_count between 0 and 1),
  revision_requested_at timestamptz,
  revision_reason       text,
  revision_due_at       timestamptz,
  -- the pilot recording fields (runbook / spec section 22, Phase 1)
  active_edit_seconds   int not null default 0,
  expert_minutes_reported int,                                           -- operator's note if the automatic figure is not right
  score_before          int check (score_before between 0 and 100),
  score_after           int check (score_after between 0 and 100),
  rating_stars          smallint check (rating_stars between 1 and 5),
  rating_tags           text[],
  rating_at             timestamptz,
  other_cost_cents      int not null default 0 check (other_cost_cents >= 0),  -- refunds aside: card fees and anything else the operator logs
  late_credit_cents     int not null default 0 check (late_credit_cents >= 0),
  operator_note         text,
  purged_at             timestamptz,                                       -- job files and working documents deleted (retention / account deletion)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- a job has an expert if and only if it is in one of these states (engineering spec 5.1)
  constraint human_jobs_expert_state_check check (
    (state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted') and expert_id is not null)
    or (state in ('awaiting_payment', 'offered', 'open', 'cancelled') and expert_id is null)
    or state in ('disputed', 'refunded'))
);
create index if not exists human_jobs_state_idx        on human_jobs (state, created_at);
create index if not exists human_jobs_expert_state_idx on human_jobs (expert_id, state);
create index if not exists human_jobs_customer_idx     on human_jobs (customer_user_id);
create index if not exists human_jobs_auto_accept_idx  on human_jobs (auto_accept_at) where state = 'delivered';
alter table human_jobs enable row level security;
revoke all on human_jobs from anon, authenticated;

-- ── job_events: append-only; never resume text, names or contact details ──────────────────────────────────────────────────
create table if not exists job_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references human_jobs(id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null,
  actor_kind  text not null check (actor_kind in ('system', 'expert', 'customer', 'operator')),
  actor_id    uuid,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists job_events_job_idx on job_events (job_id, id);
alter table job_events enable row level security;
revoke all on job_events from anon, authenticated;

-- ── job_documents / job_locked_values ──────────────────────────────────────────────────────────────────────────────────────
create table if not exists job_documents (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references human_jobs(id) on delete cascade,
  kind          text not null check (kind in ('source', 'ai_draft', 'working', 'delivered', 'revision')),
  version       int not null check (version >= 1),
  body          jsonb not null,                     -- structured resume with stable ids; locked fields hold markers, never values
  cover_letter  jsonb,
  created_at    timestamptz not null default now(),
  unique (job_id, kind, version)
);
alter table job_documents enable row level security;
revoke all on job_documents from anon, authenticated;

create table if not exists job_locked_values (
  job_id      uuid not null references human_jobs(id) on delete cascade,
  path        text not null,
  value_enc   text not null,                        -- sealed (AES-GCM); read only by delivery code and operator unmask
  created_at  timestamptz not null default now(),
  primary key (job_id, path)
);
alter table job_locked_values enable row level security;
revoke all on job_locked_values from anon, authenticated;

-- ── job_deliveries ─────────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists job_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references human_jobs(id) on delete cascade,
  version             smallint not null check (version in (1, 2)),    -- 1 = first delivery, 2 = the one revision
  document_id         uuid references job_documents(id),
  score_before        int check (score_before between 0 and 100),
  score_after         int check (score_after between 0 and 100),
  report              jsonb,
  diff                jsonb,
  confirmation_items  jsonb not null default '[]'::jsonb,
  change_summary      text,
  files               jsonb not null default '{}'::jsonb,             -- R2 keys for the Word and PDF files
  delivery_note       text,
  delivered_at        timestamptz not null default now(),
  unique (job_id, version)
);
alter table job_deliveries enable row level security;
revoke all on job_deliveries from anon, authenticated;

-- ── job_questions: up to three per job ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists job_questions (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references human_jobs(id) on delete cascade,
  seq                 smallint not null check (seq between 1 and 3),
  body                text not null,
  options             jsonb,
  asked_at            timestamptz not null default now(),
  answer_deadline_at  timestamptz not null,
  answered_at         timestamptz,
  answer_body         text,
  status              text not null default 'pending' check (status in ('pending', 'answered', 'expired')),
  unique (job_id, seq)
);
alter table job_questions enable row level security;
revoke all on job_questions from anon, authenticated;

-- ── job_materials: supporting files (masked text for experts; the original stays customer-only) ───────────────────────────
create table if not exists job_materials (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references human_jobs(id) on delete cascade,
  kind                  text not null check (kind in ('file', 'link')),
  label                 text,
  extracted_masked_text text,
  original_object_key   text,
  link_url              text,
  status                text not null default 'ready' check (status in ('ready', 'refused', 'removed')),
  created_at            timestamptz not null default now()
);
create index if not exists job_materials_job_idx on job_materials (job_id);
alter table job_materials enable row level security;
revoke all on job_materials from anon, authenticated;

-- ── expert_payouts (minimal, hand-recorded) / expert_earnings (append-only ledger) ────────────────────────────────────────
create table if not exists expert_payouts (
  id               uuid primary key default gen_random_uuid(),
  expert_id        uuid not null references expert_accounts(id),
  amount_cents     int not null check (amount_cents > 0),
  currency         text not null default 'USD',
  method           text not null,
  reference        text,
  idempotency_key  text not null unique,
  paid_at          timestamptz not null default now(),
  note             text,
  created_at       timestamptz not null default now()
);
alter table expert_payouts enable row level security;
revoke all on expert_payouts from anon, authenticated;

create table if not exists expert_earnings (
  id            uuid primary key default gen_random_uuid(),
  expert_id     uuid not null references expert_accounts(id),
  job_id        uuid references human_jobs(id),
  kind          text not null check (kind in ('pay', 'bonus', 'tier_bonus', 'penalty', 'adjustment', 'reversal')),
  amount_cents  int not null,
  release_at    timestamptz not null,
  payout_id     uuid references expert_payouts(id),
  reason        text,
  created_at    timestamptz not null default now()
);
create unique index if not exists expert_earnings_one_pay_per_job on expert_earnings (job_id) where kind = 'pay';
create unique index if not exists expert_earnings_one_reversal_per_job on expert_earnings (job_id) where kind = 'reversal';
create index if not exists expert_earnings_expert_idx on expert_earnings (expert_id, payout_id);
alter table expert_earnings enable row level security;
revoke all on expert_earnings from anon, authenticated;

-- ── expert_audit_log: every expert / staff read of client content, and every denied attempt ───────────────────────────────
create table if not exists expert_audit_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  actor_kind   text not null check (actor_kind in ('expert', 'operator', 'system')),
  actor_id     uuid,
  action       text not null,
  target_type  text not null,
  target_id    text,
  detail       jsonb not null default '{}'::jsonb      -- identifiers, counts, reason codes: never resume text
);
create index if not exists expert_audit_log_target_idx on expert_audit_log (target_type, target_id, id);
alter table expert_audit_log enable row level security;
revoke all on expert_audit_log from anon, authenticated;

-- every foreign key is indexed by its leading column (the repo's own migration test requires it)
create index if not exists human_jobs_scan_idx            on human_jobs (scan_id) where scan_id is not null;
create index if not exists job_deliveries_document_idx    on job_deliveries (document_id) where document_id is not null;
create index if not exists expert_payouts_expert_idx      on expert_payouts (expert_id);
create index if not exists expert_earnings_payout_idx     on expert_earnings (payout_id) where payout_id is not null;

-- ── settings: defaults from engineering spec section 15 / product spec 16 (system_state key 'human_pilot') ────────────────
-- Prices and pay are integer cents. polish is OFF: the specification defines no turnaround for it, so it cannot be promised.
-- pilot_cap_orders is the owner's cap on PAID orders (15). Editing: update system_state set value = ... where key = 'human_pilot'.
insert into system_state (key, value) values ('human_pilot', jsonb_build_object(
  'settings_version', 1,
  'prices',  jsonb_build_object('polish', 5900, 'seven_day', 8900, 'forty_eight_hour', 11900, 'twenty_four_hour', 14900, 'cover_letter', 2900),
  'pay',     jsonb_build_object('polish', 2500, 'seven_day', 5000, 'forty_eight_hour', 7000, 'twenty_four_hour', 9000, 'cover_letter', 1800),
  'tiers_enabled', jsonb_build_object('polish', false, 'seven_day', true, 'forty_eight_hour', true, 'twenty_four_hour', true),
  'turnaround_hours', jsonb_build_object('seven_day', 168, 'forty_eight_hour', 48, 'twenty_four_hour', 24),
  'internal_buffer_hours', jsonb_build_object('seven_day', 12, 'forty_eight_hour', 4, 'twenty_four_hour', 2),
  'pilot_cap_orders', 15,
  'pending_expiry_hours', 24,
  'accept_auto_hours', 72,
  'revision_window_days', 7,
  'revision_hours', jsonb_build_object('twenty_four_hour', 24, 'other', 48),
  'question_max', 3,
  'question_answer_hours', 24,
  'earnings_hold_days', 3,
  'payout_min_cents', 2500,
  'concurrent_cap', 2,
  'retention_drafts_days', 90,
  'materials_max_files', 3,
  'materials_max_bytes', 5242880
)) on conflict (key) do nothing;

-- ══ functions (service role only) ═══════════════════════════════════════════════════════════════════════════════════════════

-- Assign a job to an expert by hand (the operator). One winner, caps and eligibility checked in the same statement.
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
  select count(*) into active_n from human_jobs
    where expert_id = p_expert and state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision');
  if active_n >= p_max_active then return jsonb_build_object('ok', false, 'reason', 'cap', 'active', active_n); end if;
  update human_jobs set state = 'claimed', expert_id = p_expert, claimed_at = now(), version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'taken', 'operator', p_operator, jsonb_build_object('how', 'assigned_by_hand'));
  return jsonb_build_object('ok', true);
end $$;

-- Take a job back from an expert before any work was delivered (give back / reassign).
create or replace function human_job_unassign(p_job uuid, p_operator uuid, p_reason text default null)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state not in ('claimed', 'in_progress', 'waiting_customer') then return jsonb_build_object('ok', false, 'reason', 'not_unassignable', 'state', j.state); end if;
  update human_jobs set state = 'offered', expert_id = null, claimed_at = null, version = version + 1,
         pause_started_at = null, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'released', 'operator', p_operator, jsonb_build_object('reason', left(coalesce(p_reason, ''), 120)));
  return jsonb_build_object('ok', true);
end $$;

-- The ONLY way expert code reads a client's content. Returns null (and logs the attempt) unless the job is assigned to this expert
-- and the expert's access has not ended (delivery plus the revision window, then nothing).
create or replace function human_job_expert_read(p_job uuid, p_expert uuid, p_window_days int default 7)
returns jsonb language plpgsql as $$
declare j human_jobs; allowed boolean; out jsonb;
begin
  select * into j from human_jobs where id = p_job;
  allowed := found and j.expert_id = p_expert
    and (j.state in ('claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision')
         or (j.state in ('delivered', 'accepted') and coalesce(j.delivered_at, now()) + make_interval(days => p_window_days) > now()));
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
            'internal_deadline_at', j.internal_deadline_at, 'revision_count', j.revision_count, 'revision_reason', j.revision_reason,
            'revision_due_at', j.revision_due_at, 'version', j.version, 'brief', j.brief, 'score_before', j.score_before),
    'source',   (select body from job_documents where job_id = p_job and kind = 'source'   order by version desc limit 1),
    'ai_draft', (select body from job_documents where job_id = p_job and kind = 'ai_draft' order by version desc limit 1),
    'working',  (select jsonb_build_object('version', version, 'body', body, 'cover_letter', cover_letter) from job_documents
                  where job_id = p_job and kind = 'working' order by version desc limit 1),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'seq', seq, 'body', body, 'status', status, 'answer_body', answer_body,
                  'asked_at', asked_at, 'answer_deadline_at', answer_deadline_at) order by seq) from job_questions where job_id = p_job), '[]'::jsonb),
    'materials', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'text', extracted_masked_text) order by created_at)
                  from job_materials where job_id = p_job and kind = 'file' and status = 'ready'), '[]'::jsonb)
  ) into out;
  return out;
end $$;

-- The ONLY way expert code writes a working document. Compare-and-set on the document version; counts idle-aware editing seconds.
create or replace function human_job_expert_save(p_job uuid, p_expert uuid, p_base_version int, p_body jsonb, p_cover jsonb, p_seconds int)
returns jsonb language plpgsql as $$
declare j human_jobs; cur int; secs int;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.expert_id is distinct from p_expert or j.state not in ('claimed', 'in_progress', 'revision') then
    insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail)
      values ('expert', p_expert, 'denied_job_save', 'human_job', p_job::text, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;
  select coalesce(max(version), 0) into cur from job_documents where job_id = p_job and kind = 'working';
  if cur <> p_base_version then return jsonb_build_object('ok', false, 'reason', 'conflict', 'current_version', cur); end if;
  secs := greatest(0, least(coalesce(p_seconds, 0), 600));
  insert into job_documents (job_id, kind, version, body, cover_letter) values (p_job, 'working', cur + 1, p_body, p_cover);
  update human_jobs set active_edit_seconds = active_edit_seconds + secs,
         state = case when state = 'claimed' then 'in_progress' else state end,
         version = case when state = 'claimed' then version + 1 else version end, updated_at = now() where id = p_job;
  if j.state = 'claimed' then
    insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'started', 'expert', p_expert, '{}'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'version', cur + 1);
end $$;

-- Acceptance: the delivered job becomes accepted and EXACTLY ONE pay row is written (unique index = the last guard).
create or replace function human_job_accept(p_job uuid, p_actor_kind text, p_actor uuid, p_hold_days int default 3)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state = 'accepted' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.state <> 'delivered' then return jsonb_build_object('ok', false, 'reason', 'not_delivered', 'state', j.state); end if;
  update human_jobs set state = 'accepted', accepted_at = now(), auto_accept_at = null, version = version + 1, updated_at = now() where id = p_job;
  insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
    values (j.expert_id, p_job, 'pay', j.expert_pay_cents, now() + make_interval(days => p_hold_days), 'accepted')
    on conflict do nothing;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'accepted', p_actor_kind, p_actor, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- Refund / cancel: moves the job to its terminal state and reverses earnings that exist (once; a repeat changes nothing).
create or replace function human_job_reverse(p_job uuid, p_reason text)
returns jsonb language plpgsql as $$
declare j human_jobs; target text;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state in ('refunded', 'cancelled') then return jsonb_build_object('ok', true, 'already', true); end if;
  target := case when j.state in ('awaiting_payment', 'offered', 'open') then 'cancelled' else 'refunded' end;
  -- a refunded job returns to a state with no expert only through the terminal states, which allow either
  update human_jobs set state = target, expert_id = case when target = 'cancelled' then null else expert_id end,
         version = version + 1, updated_at = now() where id = p_job;
  insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at, reason)
    select e.expert_id, e.job_id, 'reversal', -e.amount_cents, now(), left(coalesce(p_reason, 'refund'), 120)
    from expert_earnings e where e.job_id = p_job and e.kind = 'pay'
    on conflict do nothing;
  insert into job_events (job_id, kind, actor_kind, detail) values (p_job, case when target = 'cancelled' then 'cancelled' else 'refunded' end, 'system', jsonb_build_object('reason', left(coalesce(p_reason, ''), 120)));
  return jsonb_build_object('ok', true, 'already', false, 'state', target);
end $$;

-- A manual payout run for one expert: sums what is available (hold passed, no payout yet; reversals net), records it once
-- under an idempotency key, and stamps the rows with the payout id, all in one transaction.
create or replace function expert_record_payout(p_expert uuid, p_method text, p_reference text, p_key text, p_min_cents int, p_note text default null)
returns jsonb language plpgsql as $$
declare existing expert_payouts; total int; pid uuid;
begin
  select * into existing from expert_payouts where idempotency_key = p_key;
  if found then return jsonb_build_object('ok', true, 'already', true, 'payout_id', existing.id, 'amount_cents', existing.amount_cents); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_expert::text, 0));
  select coalesce(sum(amount_cents), 0) into total from expert_earnings where expert_id = p_expert and payout_id is null and release_at <= now();
  if total < greatest(p_min_cents, 1) then return jsonb_build_object('ok', false, 'reason', 'below_minimum', 'available_cents', total); end if;
  insert into expert_payouts (expert_id, amount_cents, method, reference, idempotency_key, note) values (p_expert, total, p_method, p_reference, p_key, p_note) returning id into pid;
  update expert_earnings set payout_id = pid where expert_id = p_expert and payout_id is null and release_at <= now();
  return jsonb_build_object('ok', true, 'already', false, 'payout_id', pid, 'amount_cents', total);
end $$;

revoke execute on function human_job_assign(uuid, uuid, uuid, int)                              from public, anon, authenticated;
revoke execute on function human_job_unassign(uuid, uuid, text)                                 from public, anon, authenticated;
revoke execute on function human_job_expert_read(uuid, uuid, int)                               from public, anon, authenticated;
revoke execute on function human_job_expert_save(uuid, uuid, int, jsonb, jsonb, int)            from public, anon, authenticated;
revoke execute on function human_job_accept(uuid, text, uuid, int)                              from public, anon, authenticated;
revoke execute on function human_job_reverse(uuid, text)                                        from public, anon, authenticated;
revoke execute on function expert_record_payout(uuid, text, text, text, int, text)              from public, anon, authenticated;
grant  execute on function human_job_assign(uuid, uuid, uuid, int)                              to service_role;
grant  execute on function human_job_unassign(uuid, uuid, text)                                 to service_role;
grant  execute on function human_job_expert_read(uuid, uuid, int)                               to service_role;
grant  execute on function human_job_expert_save(uuid, uuid, int, jsonb, jsonb, int)            to service_role;
grant  execute on function human_job_accept(uuid, text, uuid, int)                              to service_role;
grant  execute on function human_job_reverse(uuid, text)                                        to service_role;
grant  execute on function expert_record_payout(uuid, text, text, text, int, text)              to service_role;



-- The document an expert STARTED from (the AI draft, else the client's original) and the starting cover letter: what the server
-- validates every save against. Same gate as human_job_expert_read; a denied attempt is logged, a granted one is not (it is not a view).
create or replace function human_job_expert_baseline(p_job uuid, p_expert uuid)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job;
  if not found or j.expert_id is distinct from p_expert or j.state not in ('claimed', 'in_progress', 'revision') then
    insert into expert_audit_log (actor_kind, actor_id, action, target_type, target_id, detail) values ('expert', p_expert, 'denied_job_save', 'human_job', p_job::text, '{}'::jsonb);
    return null;
  end if;
  return jsonb_build_object(
    'body', coalesce((select body from job_documents where job_id = p_job and kind = 'ai_draft' order by version desc limit 1),
                     (select body from job_documents where job_id = p_job and kind = 'source' order by version desc limit 1)),
    'cover_letter', (select cover_letter from job_documents where job_id = p_job and kind = 'working' order by version asc limit 1));
end $$;

-- ── payment confirmed: awaiting_payment -> offered, exactly once ───────────────────────────────────────────────────────────
-- Called by the settlement hook for a human payment. A repeat (the verify call, the webhook and the sweep all land here) changes nothing.
create or replace function human_job_confirm_payment(p_payment uuid, p_promised timestamptz, p_internal timestamptz)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where payment_id = p_payment for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_job'); end if;
  if j.state <> 'awaiting_payment' then return jsonb_build_object('ok', true, 'already', true, 'job_id', j.id, 'state', j.state); end if;
  update human_jobs set state = 'offered', paid_at = now(), promised_deadline_at = p_promised, internal_deadline_at = p_internal,
         version = version + 1, updated_at = now() where id = j.id;
  insert into job_events (job_id, kind, actor_kind, detail) values (j.id, 'paid', 'system', '{}'::jsonb);
  return jsonb_build_object('ok', true, 'already', false, 'job_id', j.id, 'state', 'offered');
end $$;

-- ── a clarifying question (up to three): the clock stops until answered ────────────────────────────────────────────────────
create or replace function human_job_ask(p_job uuid, p_expert uuid, p_body text, p_options jsonb, p_answer_hours int, p_max int default 3)
returns jsonb language plpgsql as $$
declare j human_jobs; n int; qid uuid;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.expert_id is distinct from p_expert or j.state <> 'in_progress' then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  select count(*) into n from job_questions where job_id = p_job;
  if n >= p_max then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  if char_length(coalesce(trim(p_body), '')) = 0 or char_length(p_body) > 600 then return jsonb_build_object('ok', false, 'reason', 'bad_question'); end if;
  insert into job_questions (job_id, seq, body, options, answer_deadline_at) values (p_job, n + 1, p_body, p_options, now() + make_interval(hours => p_answer_hours)) returning id into qid;
  update human_jobs set state = 'waiting_customer', pause_started_at = now(), version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'question_asked', 'expert', p_expert, jsonb_build_object('seq', n + 1));
  return jsonb_build_object('ok', true, 'question_id', qid, 'seq', n + 1);
end $$;

-- shared by answering and by a question running out of time: resume work, push both deadlines back by the time spent waiting
create or replace function human_job_resume_from_wait(p_job uuid, p_kind text, p_actor_kind text, p_actor uuid)
returns void language plpgsql as $$
declare j human_jobs; secs int;
begin
  select * into j from human_jobs where id = p_job for update;
  if j.state <> 'waiting_customer' then return; end if;
  secs := greatest(0, floor(extract(epoch from (now() - coalesce(j.pause_started_at, now()))))::int);
  update human_jobs set state = 'in_progress', pause_started_at = null, paused_seconds = paused_seconds + secs,
         promised_deadline_at = promised_deadline_at + make_interval(secs => secs), internal_deadline_at = internal_deadline_at + make_interval(secs => secs),
         version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, p_kind, p_actor_kind, p_actor, jsonb_build_object('paused_seconds', secs));
end $$;

create or replace function human_job_answer(p_job uuid, p_customer uuid, p_question uuid, p_body text)
returns jsonb language plpgsql as $$
declare j human_jobs; q job_questions;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.customer_user_id <> p_customer then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select * into q from job_questions where id = p_question and job_id = p_job for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if q.status = 'answered' then return jsonb_build_object('ok', true, 'already', true); end if;
  if q.status <> 'pending' or j.state <> 'waiting_customer' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if char_length(coalesce(trim(p_body), '')) = 0 or char_length(p_body) > 2000 then return jsonb_build_object('ok', false, 'reason', 'bad_answer'); end if;
  update job_questions set status = 'answered', answered_at = now(), answer_body = p_body where id = p_question;
  perform human_job_resume_from_wait(p_job, 'question_answered', 'customer', p_customer);
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- hourly: a question nobody answered in time expires and the job carries on (the expert does their best)
create or replace function human_job_expire_questions()
returns int language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select q.id, q.job_id from job_questions q join human_jobs h on h.id = q.job_id
           where q.status = 'pending' and q.answer_deadline_at < now() and h.state = 'waiting_customer' loop
    update job_questions set status = 'expired' where id = r.id;
    perform human_job_resume_from_wait(r.job_id, 'question_expired', 'system', null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── expert submits for review; the operator returns it or delivers it ──────────────────────────────────────────────────────
create or replace function human_job_submit(p_job uuid, p_expert uuid)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.expert_id is distinct from p_expert or j.state not in ('in_progress', 'revision', 'claimed') then return jsonb_build_object('ok', false, 'reason', 'not_allowed'); end if;
  if not exists (select 1 from job_documents where job_id = p_job and kind = 'working') then return jsonb_build_object('ok', false, 'reason', 'nothing_saved'); end if;
  update human_jobs set state = 'in_review', version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'submitted', 'expert', p_expert, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

create or replace function human_job_return_to_expert(p_job uuid, p_operator uuid, p_note text)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.state <> 'in_review' then return jsonb_build_object('ok', false, 'reason', 'not_in_review'); end if;
  update human_jobs set state = case when revision_count > 0 and delivered_at is not null and revision_requested_at is not null and revision_requested_at >= delivered_at then 'revision' else 'in_progress' end,
         operator_note = left(coalesce(p_note, ''), 500), version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'returned', 'operator', p_operator, jsonb_build_object('note_length', char_length(coalesce(p_note, ''))));
  return jsonb_build_object('ok', true);
end $$;

-- Delivery (the operator's approval): in_review -> delivered. Writes the delivery row (version 1, or 2 after the revision) and starts
-- the 72-hour acceptance clock. The document stored here is the MASKED body; the real files are built by the Worker and recorded in `files`.
create or replace function human_job_deliver(p_job uuid, p_operator uuid, p_files jsonb, p_score_before int, p_score_after int, p_report jsonb,
                                             p_diff jsonb, p_confirmations jsonb, p_summary text, p_note text, p_auto_hours int)
returns jsonb language plpgsql as $$
declare j human_jobs; doc job_documents; ver int; did uuid;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.state <> 'in_review' then return jsonb_build_object('ok', false, 'reason', 'not_in_review'); end if;
  select * into doc from job_documents where job_id = p_job and kind = 'working' order by version desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'nothing_saved'); end if;
  ver := j.revision_count + 1;
  insert into job_documents (job_id, kind, version, body, cover_letter) values (p_job, 'delivered', ver, doc.body, doc.cover_letter);
  insert into job_deliveries (job_id, version, document_id, score_before, score_after, report, diff, confirmation_items, change_summary, files, delivery_note)
    values (p_job, ver, (select id from job_documents where job_id = p_job and kind = 'delivered' and version = ver), p_score_before, p_score_after, p_report, p_diff,
            coalesce(p_confirmations, '[]'::jsonb), p_summary, coalesce(p_files, '{}'::jsonb), p_note) returning id into did;
  update human_jobs set state = 'delivered', delivered_at = now(), auto_accept_at = now() + make_interval(hours => p_auto_hours),
         score_before = coalesce(score_before, p_score_before), score_after = p_score_after, version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'delivered', 'operator', p_operator, jsonb_build_object('delivery_version', ver));
  return jsonb_build_object('ok', true, 'delivery_id', did, 'delivery_version', ver);
end $$;

-- ── the one revision round ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function human_job_request_revision(p_job uuid, p_customer uuid, p_reason text, p_window_days int, p_hours int)
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.customer_user_id <> p_customer then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state = 'revision' then return jsonb_build_object('ok', true, 'already', true); end if;
  if j.state <> 'delivered' then return jsonb_build_object('ok', false, 'reason', 'not_delivered', 'state', j.state); end if;
  if j.revision_count >= 1 then return jsonb_build_object('ok', false, 'reason', 'revision_used'); end if;
  if j.delivered_at + make_interval(days => p_window_days) < now() then return jsonb_build_object('ok', false, 'reason', 'window_closed'); end if;
  if char_length(coalesce(trim(p_reason), '')) < 3 or char_length(p_reason) > 1500 then return jsonb_build_object('ok', false, 'reason', 'bad_reason'); end if;
  update human_jobs set state = 'revision', revision_count = 1, revision_requested_at = now(), revision_reason = p_reason,
         revision_due_at = now() + make_interval(hours => p_hours), auto_accept_at = null, version = version + 1, updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'revision_requested', 'customer', p_customer, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- ── rating: once, by the customer, after delivery ──────────────────────────────────────────────────────────────────────────
create or replace function human_job_rate(p_job uuid, p_customer uuid, p_stars int, p_tags text[])
returns jsonb language plpgsql as $$
declare j human_jobs;
begin
  select * into j from human_jobs where id = p_job for update;
  if not found or j.customer_user_id <> p_customer then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if j.state not in ('delivered', 'accepted', 'revision') then return jsonb_build_object('ok', false, 'reason', 'not_delivered'); end if;
  if j.rating_stars is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_stars is null or p_stars not between 1 and 5 then return jsonb_build_object('ok', false, 'reason', 'bad_rating'); end if;
  update human_jobs set rating_stars = p_stars, rating_tags = p_tags, rating_at = now(), updated_at = now() where id = p_job;
  insert into job_events (job_id, kind, actor_kind, actor_id, detail) values (p_job, 'rated', 'customer', p_customer, jsonb_build_object('stars', p_stars));
  return jsonb_build_object('ok', true, 'already', false);
end $$;

-- hourly: delivered jobs the customer neither accepted nor challenged within the window are accepted for them (once)
create or replace function human_job_auto_accept_due(p_hold_days int)
returns int language plpgsql as $$
declare r record; n int := 0; res jsonb;
begin
  for r in select id from human_jobs where state = 'delivered' and auto_accept_at is not null and auto_accept_at <= now() order by auto_accept_at limit 200 loop
    res := human_job_accept(r.id, 'system', null, p_hold_days);
    if (res->>'ok')::boolean and not coalesce((res->>'already')::boolean, false) then n := n + 1; end if;
  end loop;
  return n;
end $$;

do $$ declare sig text; begin
  for sig in select unnest(array[
    'human_job_expert_baseline(uuid, uuid)', 'human_job_confirm_payment(uuid, timestamptz, timestamptz)', 'human_job_ask(uuid, uuid, text, jsonb, int, int)',
    'human_job_resume_from_wait(uuid, text, text, uuid)', 'human_job_answer(uuid, uuid, uuid, text)', 'human_job_expire_questions()',
    'human_job_submit(uuid, uuid)', 'human_job_return_to_expert(uuid, uuid, text)',
    'human_job_deliver(uuid, uuid, jsonb, int, int, jsonb, jsonb, jsonb, text, text, int)', 'human_job_request_revision(uuid, uuid, text, int, int)',
    'human_job_rate(uuid, uuid, int, text[])', 'human_job_auto_accept_due(int)']) loop
    execute format('revoke execute on function %s from public, anon, authenticated', sig);
    execute format('grant execute on function %s to service_role', sig);
  end loop;
end $$;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (124, '0124_experts_phase1_pilot')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 124, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 124;   -- never move the version BACKWARDS (a re-run of an older file)
