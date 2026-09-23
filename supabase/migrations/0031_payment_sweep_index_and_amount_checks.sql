-- 0031_payment_sweep_index_and_amount_checks.sql
-- AUDIT FIX (Section 9/10 pass). Idempotent — safe to re-run.

-- ── PART 1 — index the payments sweep access pattern ─────────────────────────
-- Three separate hourly cron jobs (reconcile.service.js's
-- sweepOrphanedPayments, sweepStalePendingPayments, and sweepPendingPayments,
-- all driven from index.js's `scheduled` export) each query `payments`
-- filtered by `status` (eq/in) plus a `created_at` range, ordered by
-- created_at. The only existing indexes on this table are (user_id),
-- (paystack_ref), and the composite (scan_id, status) — none of which serve
-- this access pattern. Every one of these three queries has been a full
-- table scan since the day reconcile.service.js shipped, run every hour,
-- forever, getting slower as the table grows. A single composite index on
-- (status, created_at) serves all three: they all lead with an equality/IN
-- filter on status, then range-filter created_at within that.
create index if not exists idx_payments_status_created_at on payments (status, created_at);

-- ── PART 2 — index the email_logs retention purge ────────────────────────────
-- retention.service.js's purgeOldLogs deletes from email_logs WHERE sent_at <
-- (now - 90 days), every hour, with no supporting index. The 90-day cap
-- bounds how bad this gets, but there's no reason to pay a sequential scan
-- for a delete this table's own retention policy already runs on a fixed
-- schedule.
create index if not exists idx_email_logs_sent_at on email_logs (sent_at);

-- ── PART 3 — non-negative CHECK constraints on money columns ─────────────────
-- 0015 added range CHECKs on every *_score column and partners.commission_rate
-- specifically reasoning that "a scoring bug anywhere upstream could silently
-- write [an invalid value] with nothing at the DB layer to catch it." That
-- same reasoning was never applied to the money columns, which are at least
-- as consequential — payments.amount_cents and payouts.amount_cents should
-- never be negative (unlike commission_ledger's amount columns, which are
-- deliberately signed to represent refund/chargeback reversal rows — see
-- 0025's comment on that design; this constraint is intentionally NOT added
-- there).
--
-- partners.controller.js's adminRecordPayout already guards this at the API
-- layer (recordPayoutSchema's z.number().int().positive()), so this is
-- defense-in-depth, not a fix for a live incident — but that same function's
-- comment currently claims "negative amounts fail the payouts check
-- constraint", which was false until this migration (see the companion fix
-- to that comment).
--
-- Added `not valid` + validated in the SAME migration, immediately below —
-- not deferred "for whenever convenient" the way 0015's were. 0030 had to
-- come back 15 migrations later to clean up exactly that deferral; there's
-- no reason to reintroduce the same loose end on new constraints when the
-- validate step costs nothing on a column that's never legitimately held a
-- negative value.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_amount_cents_nonnegative') then
    alter table payments add constraint payments_amount_cents_nonnegative check (amount_cents >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payouts_amount_cents_nonnegative') then
    alter table payouts add constraint payouts_amount_cents_nonnegative check (amount_cents >= 0) not valid;
  end if;
end $$;

alter table payments validate constraint payments_amount_cents_nonnegative;
alter table payouts   validate constraint payouts_amount_cents_nonnegative;
