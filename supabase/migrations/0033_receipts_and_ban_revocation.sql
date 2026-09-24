-- 0033_receipts_and_ban_revocation.sql
-- Round-2 audit of sections 7 (Verify) + 8 (Webhooks). Idempotent — safe to re-run.

-- ── payments.receipt_sent_at ────────────────────────────────────────────────
-- The payment receipt used to be sent only by whichever caller "won" the
-- PENDING -> SUCCESS flip. If that caller's fulfilment threw right after the
-- flip, its redelivery finished the job but never sent the receipt (and never
-- recorded the partner commission). The receipt is now claimed atomically
-- (UPDATE ... WHERE receipt_sent_at IS NULL) by whichever delivery actually
-- finishes the job, so it goes out exactly once.
alter table payments add column if not exists receipt_sent_at timestamptz;

-- Every payment that already reached a settled state has had its receipt handled
-- by the old code; mark them so a late redelivery can never mail a second one.
update payments
   set receipt_sent_at = coalesce(created_at, now())
 where receipt_sent_at is null
   and status in ('SUCCESS', 'REFUNDED', 'DISPUTED');

-- ── scans.verification_revoked_reason: add 'BAN' ────────────────────────────
-- Banning an account now takes its public verification pages down (they stayed
-- live — with any exposed .docx/PDF — for a banned user). 'BAN' is its own
-- reason so that (a) the owner can never republish it, and (b) un-banning
-- restores exactly the pages the ban took down — never one the owner had
-- unpublished themselves, nor a refund/dispute/admin takedown.
alter table scans drop constraint if exists scans_verification_revoked_reason_check;
alter table scans add constraint scans_verification_revoked_reason_check
  check (verification_revoked_reason is null
         or verification_revoked_reason in ('OWNER', 'REFUND', 'DISPUTE', 'ADMIN', 'BAN'));
