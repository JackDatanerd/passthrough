-- 0037_payments_pending_uniqueness.sql
-- AUDIT FIX (Section 3/4 pass, bug). Idempotent — safe to re-run.
--
-- initializePayment (payments.controller.js) already treats "one open
-- checkout per scan" as the invariant it's trying to hold — see its own
-- extensive comment on why it resumes-or-blocks rather than overwriting an
-- existing PENDING row — but the guard was a plain SELECT-then-INSERT, not
-- atomic. Two initializePayment calls for the same scan landing within that
-- read-then-write window (double-click before the frontend's own guard
-- disables the button, two open tabs) could both see "no existing PENDING
-- row" and both insert one: two live Paystack checkouts for one scan, with
-- nothing application-level stopping the user from completing both and
-- being charged twice (the atomic claim on scans.fix_purchased only
-- prevents double DELIVERY, not double CHARGE — the second payment still
-- settles as a real, separate SUCCESS that fulfillment.service.js's
-- fulfillPayment then has to mark DUPLICATE and a human has to refund by
-- hand). Every other money-moving write in this codebase closes exactly
-- this shape of race with a DB-level constraint or an atomic
-- UPDATE...WHERE-still-unclaimed...RETURNING claim (see 0031's
-- payments_amount_cents_nonnegative check, or the payout-settlement claim in
-- partners.controller.js's adminRecordPayout) — this was the one
-- money-moving write in the app that didn't have one.
--
-- Before adding the constraint: collapse any pre-existing duplicate PENDING
-- rows per scan down to the most recent one, so the unique index below
-- doesn't fail to create against data written before this fix existed. Only
-- rows still sitting PENDING today are touched — anything already flipped
-- to SUCCESS/FAILED/ABANDONED is untouched, and a row still PENDING by now
-- was never fulfilled anyway.
with ranked as (
  select id,
         row_number() over (partition by scan_id order by created_at desc) as rn
  from payments
  where status = 'PENDING'
)
update payments
set status = 'ABANDONED'
where id in (select id from ranked where rn > 1);

-- The guard itself: at most one PENDING payment per scan, enforced by
-- Postgres rather than by a read that can go stale between the check and
-- the write. payments.controller.js's initializePayment now catches the
-- resulting 23505 on a losing concurrent insert and folds back into the
-- same resume-or-block decision it already makes for a pending row found up
-- front, instead of the two callers ever both succeeding.
create unique index if not exists payments_scan_id_pending_uidx
  on payments (scan_id) where status = 'PENDING';
