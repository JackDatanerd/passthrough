-- Partners / referral program, round 5.
--
-- 1. payouts.voided_at / void_reason
--    A payout recorded by mistake (wrong amount, wrong partner, wrong cycle) could only be
--    undone with hand-written SQL. Voiding now keeps the payout row for the audit trail
--    (voided_at is set) and releases the ledger rows it settled (payout_id back to NULL), so
--    the commission is owed again and the partner dashboard / payable figures self-correct.
--    A column rather than a new payout_status_enum value: ALTER TYPE ... ADD VALUE cannot be
--    used inside the transaction that adds it, and every reader already filters on this.
--
-- 2. partners.notify_conversions
--    One email per sale is the right default, but a busy partner had no way to turn it off.
--    Reversal, payout and account emails are never affected by this flag.

alter table payouts  add column if not exists voided_at   timestamptz;
alter table payouts  add column if not exists void_reason text;
alter table partners add column if not exists notify_conversions boolean not null default true;

create index if not exists payouts_partner_voided_idx on payouts(partner_id) where voided_at is not null;
