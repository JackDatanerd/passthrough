-- Fixes a tier-smuggling bug: verifyPayment/webhook fulfillment read
-- scans.fix_tier at completion time, but scans.fix_tier is a single mutable
-- column that initializePayment overwrites on every call. Sequence:
--   1. initializePayment(BADGE) -> reference A ($9),  scans.fix_tier = 'BADGE'
--   2. initializePayment(FIX)   -> reference B ($29), scans.fix_tier = 'FIX'  (overwrites)
--   3. pay using A's (cheaper) checkout link
--   4. fulfillment for A reads scans.fix_tier, which is now 'FIX' -> full
--      rewrite delivered for the BADGE price.
--
-- Fix: bind fix_tier to the specific payment reference at initialize time
-- (immutable per-row), and have fulfillment trust ONLY that row -- never
-- scans.fix_tier, which remains a display/downstream-logic convenience field
-- but is no longer part of the trust chain for what a given payment unlocks.

alter table payments
  add column fix_tier text check (fix_tier in ('FIX', 'BADGE', 'FIX_PLAIN'));

create index idx_payments_scan_id_status on payments (scan_id, status);
