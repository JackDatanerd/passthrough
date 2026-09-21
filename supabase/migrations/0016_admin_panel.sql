-- Admin panel support: payout-cycle tracking + a persisted record of
-- critical owner alerts.
--
-- Cycles themselves are NOT a stored concept — they're a fixed calendar rule
-- (1st-15th, 16th-end of month) computed on the fly in src/lib/cycles.js from
-- existing commission_ledger.created_at timestamps. No schema change is
-- needed to know which cycle a commission falls into. What IS new here is
-- recording, on the payout row itself, which cycle (if any) a given payout
-- was FOR — so payout history remains self-explanatory later even if the
-- cycle rule is ever tweaked. Null on both means an ad hoc/bonus payout with
-- no cycle behind it (adminRecordPayout's existing "pay everything owed"
-- path, preserved for that case).

alter table payouts add column period_start date;
alter table payouts add column period_end   date;

-- Persisted history of critical owner alerts (payment/webhook failures,
-- signature mismatches, ledger-write failures, etc.). Previously
-- sendOwnerAlert() only ever sent an email — if that email was missed,
-- filtered, or deleted, there was zero record the alert ever fired, in the
-- app or the database. This table is written by sendOwnerAlert() itself
-- (email.service.js) alongside the email, so the admin panel's System
-- Health view has a durable trail independent of the inbox.
create table alert_logs (
  id         uuid primary key default gen_random_uuid(),
  subject    text not null,
  message    text not null,
  emailed    boolean not null default false,  -- whether the email send itself succeeded
  created_at timestamptz not null default now()
);

create index alert_logs_created_idx on alert_logs (created_at desc);

-- Matches 0014_enable_rls.sql's newly-established posture: every table gets
-- RLS enabled with no policies, so PostgREST denies anon/authenticated by
-- default; service_role (what this Worker's getSupabase() always uses)
-- bypasses RLS regardless and keeps working unchanged. A table created
-- after that migration should be born into the same posture, not left as
-- the one unguarded exception.
alter table alert_logs enable row level security;
