-- 0025_verify_and_webhook_hardening.sql
-- Sections 7 (Verify) + 8 (Webhooks) audit. Idempotent — safe to re-run.
-- Requires 0024 to have been applied first (the app writes REFUNDED/DISPUTED).

-- ── scans: public verification page ─────────────────────────────────────────
-- resume_pdf_hash: the PDF is the file candidates are told to email to hiring
--   managers, but only the DOCX was ever hashed — so the file employers
--   actually receive could not be checked against anything.
-- resume_hash_history: every hash a superseded retry replaced, so an employer
--   holding an OLDER delivered file is told "earlier version", not "modified".
-- verification_status/_revoked_*: the page had no off switch at all.
-- verify_hide_name: owner control over the first name shown publicly.
-- fix_payment_id: which payment fulfilled this scan — lets fulfilment tell a
--   retried delivery of the SAME payment (no-op) from a genuine second payment
--   for an already-purchased scan (duplicate → refund, never re-generate).
alter table scans add column if not exists resume_pdf_hash            text;
alter table scans add column if not exists resume_hash_history        jsonb   not null default '[]'::jsonb;
alter table scans add column if not exists verification_status        text    not null default 'ACTIVE';
alter table scans add column if not exists verification_revoked_at    timestamptz;
alter table scans add column if not exists verification_revoked_reason text;
alter table scans add column if not exists verify_hide_name           boolean not null default false;
alter table scans add column if not exists fix_payment_id             uuid references payments(id) on delete set null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'scans_verification_status_check') then
    alter table scans add constraint scans_verification_status_check
      check (verification_status in ('ACTIVE', 'REVOKED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_verification_revoked_reason_check') then
    alter table scans add constraint scans_verification_revoked_reason_check
      check (verification_revoked_reason is null
             or verification_revoked_reason in ('OWNER', 'REFUND', 'DISPUTE', 'ADMIN'));
  end if;
end $$;

-- Backfill: attribute already-purchased scans to their earliest SUCCESS payment.
update scans s
   set fix_payment_id = p.id
  from (
    select distinct on (scan_id) id, scan_id
      from payments
     where status = 'SUCCESS' and scan_id is not null
     order by scan_id, created_at asc
  ) p
 where s.id = p.scan_id
   and s.fix_purchased
   and s.fix_payment_id is null;

-- ── payments: refund / dispute bookkeeping ──────────────────────────────────
alter table payments add column if not exists refunded_at      timestamptz;
alter table payments add column if not exists refund_reference text;
alter table payments add column if not exists disputed_at      timestamptz;

-- ── commission_ledger: reversals ────────────────────────────────────────────
-- A refund/chargeback is recorded as a NEGATIVE row that points at the row it
-- reverses, rather than mutating or deleting history. Every existing balance
-- calculation (sum of rows with payout_id null) then nets correctly with no
-- change — and if the original commission was ALREADY paid out, the negative
-- row is simply owed back and nets against the partner's next payout.
alter table commission_ledger add column if not exists reverses_ledger_id uuid references commission_ledger(id);
alter table commission_ledger add column if not exists reversal_reason    text;

-- payment_id was UNIQUE (one commission per payment). A reversal row shares
-- its payment_id, so uniqueness is now: one ORIGINAL per payment, and at most
-- one reversal per original. recordConversion's 23505 idempotency still holds.
alter table commission_ledger drop constraint if exists commission_ledger_payment_id_key;
create unique index if not exists commission_ledger_one_original_per_payment
  on commission_ledger (payment_id) where reverses_ledger_id is null;
create unique index if not exists commission_ledger_one_reversal_per_row
  on commission_ledger (reverses_ledger_id) where reverses_ledger_id is not null;

-- ── webhook_events: durable inbox ───────────────────────────────────────────
-- Every verified webhook is written here BEFORE it is processed. Gives an audit
-- trail (previously only `wrangler tail`), dedupe on Paystack's own event id,
-- and a status that makes "did we ever handle this?" answerable in SQL.
-- payload is stored with card/customer detail stripped (see webhooks.controller).
create table if not exists webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text        not null default 'paystack',
  event_key    text        not null,
  event_type   text        not null,
  reference    text,
  payload      jsonb,
  status       text        not null default 'RECEIVED'
               check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'HELD', 'FAILED')),
  attempts     int         not null default 1,
  error        text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);
create index if not exists webhook_events_status_idx    on webhook_events (status, received_at desc);
create index if not exists webhook_events_reference_idx on webhook_events (reference);
alter table webhook_events enable row level security;   -- service-role only, like every other table (see 0014)

-- ── employer_leads: which verification page produced the lead ───────────────
alter table employer_leads add column if not exists source_code text;

-- ── extend the account-scrub function (0022) to cover the columns this
--    migration just added ───────────────────────────────────────────────────
-- 0022's scrub_account_data predates resume_pdf_hash / resume_hash_history /
-- verification_status / verify_hide_name / fix_payment_id. Left unscrubbed,
-- deleting an account would leave a REVOKED-or-not status and a payment
-- reference sitting on an otherwise-nulled row forever. create-or-replace
-- with the exact same body plus these columns — everything else byte-for-byte
-- identical to 0022, per that migration's own stated intent.
--
-- No GRANT/REVOKE needed here: CREATE OR REPLACE FUNCTION preserves a
-- function's existing grants (unlike DROP + CREATE), so 0023's
-- service_role-only lockdown of this function stays exactly as it was.
create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update scans set
    resume_path              = null,
    resume_ats_path          = null,
    resume_pdf_path          = null,
    resume_original_name     = null,
    resume_hash               = null,
    resume_pdf_hash           = null,
    resume_hash_history       = '[]'::jsonb,
    job_description_text     = null,
    job_description_url      = null,
    candidate_first_name     = null,
    cover_letter_text        = null,
    raw_brain_dump_text      = null,
    original_resume_data     = null,
    rewritten_resume_data    = null,
    quantification_prompts   = null,
    full_ats_report          = null,
    verification_code        = null,
    verification_url         = null,
    verify_expose_docx       = false,
    verify_expose_pdf        = false,
    verify_hide_name         = false,
    verification_status      = 'ACTIVE',
    verification_revoked_at     = null,
    verification_revoked_reason = null,
    fix_payment_id            = null
  where user_id = p_user_id;

  update users set
    deleted_at     = now(),
    email          = 'deleted-' || p_user_id || '@passthrough.dev',
    name           = 'Deleted User',
    password_hash  = 'deleted',
    saved_profile  = null,
    token_version  = token_version + 1
  where id = p_user_id;
end;
$$;
