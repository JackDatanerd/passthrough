-- Verify + Webhooks, audit round 3 (0036: 0034-0035 are the employer-lead and job-title migrations). Idempotent — safe to re-run.
--
-- The application code degrades gracefully if this has not been applied yet (each new
-- column / table is treated as optional and falls back to the old behaviour), but apply it
-- before relying on: "removed" pages, look-up-by-file, webhook inbox notes / replay
-- attribution, the refund reconciliation sweep and lost-receipt recovery.

-- ── verification_tombstones ─────────────────────────────────────────────────
-- A deleted page (its scan, or its owner's whole account) leaves its CODE here so a link
-- already printed on a resume answers "removed by its owner" rather than a 404 that looks
-- like a typo. Only the code — nothing about the person.
create table if not exists verification_tombstones (
  code       text primary key,
  removed_at timestamptz not null default now()
);
alter table verification_tombstones enable row level security;   -- service-role only (see 0014)

-- ── look-up-by-file (GET /api/verify/by-hash/:sha256) ───────────────────────
create index if not exists idx_scans_resume_hash     on scans (resume_hash)     where resume_hash is not null;
create index if not exists idx_scans_resume_pdf_hash on scans (resume_pdf_hash) where resume_pdf_hash is not null;
create index if not exists idx_scans_resume_hash_history on scans using gin (resume_hash_history jsonb_path_ops);

-- ── webhook_events: outcome notes, replay attribution ───────────────────────
-- `error` used to hold BOTH real failures and ordinary outcome notes ("FULFILLED",
-- "reversed"), and the admin table paints it red. Notes get their own column.
alter table webhook_events add column if not exists note        text;
alter table webhook_events add column if not exists replayed_by uuid;
alter table webhook_events add column if not exists replayed_at timestamptz;

-- Rows written before this migration kept their note in `error`. Only FAILED / RECEIVED rows hold real errors.
update webhook_events
   set note = error, error = null
 where status in ('PROCESSED', 'IGNORED', 'HELD') and error is not null and note is null;

-- The stored payload no longer keeps the payer's IP address or receipt number (see
-- webhooks.controller STRIP_KEYS); scrub the ones already stored.
update webhook_events
   set payload = payload #- '{data,ip_address}' #- '{data,receipt_number}'
                          #- '{data,transaction,ip_address}' #- '{data,transaction,receipt_number}'
 where payload is not null
   and (payload #> '{data,ip_address}' is not null or payload #> '{data,receipt_number}' is not null
        or payload #> '{data,transaction,ip_address}' is not null or payload #> '{data,transaction,receipt_number}' is not null);

-- ── payments: refund reconciliation + lost-receipt recovery ─────────────────
-- last_reconciled_at: when sweepReversedPayments last asked Paystack about this payment.
-- receipt_delivered_at: set only AFTER the receipt email was actually sent. receipt_sent_at is
-- claimed BEFORE sending (so two deliveries can never both mail it), which meant a task
-- cancelled between the claim and the send lost the receipt for good.
alter table payments add column if not exists last_reconciled_at  timestamptz;
alter table payments add column if not exists receipt_delivered_at timestamptz;

update payments
   set receipt_delivered_at = receipt_sent_at
 where receipt_sent_at is not null and receipt_delivered_at is null;

create index if not exists idx_payments_reconcile
  on payments (last_reconciled_at nulls first, created_at desc)
  where status in ('SUCCESS', 'DISPUTED');
