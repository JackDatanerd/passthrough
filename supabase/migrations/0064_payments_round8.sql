-- 0064: Payments & Pricing round 8.
--
-- payments.paid_at — WHEN the money was actually settled. Until now the only timestamp on a payment row was
-- created_at, the moment the CHECKOUT was opened, and both the emailed receipt and the buyer's payment history
-- showed it as the payment date. For a checkout paid minutes later that is merely imprecise; for a mobile-money
-- approval that clears hours later, or an ABANDONED checkout that is revived by a late success, it is the wrong
-- time and can be the wrong calendar day on a document a buyer keeps for their records.
--
-- Written by fulfillment.settlePayment in the same UPDATE that flips the row to SUCCESS (so exactly once).
-- Nullable: a row that never settled has none, and a free-credit redemption ($0, created already settled) keeps
-- using created_at, which for it IS the moment.
alter table payments add column if not exists paid_at timestamptz;

-- Rows that already settled get their best available moment. created_at is the only one on record, so existing
-- receipts/history keep showing what they showed before; every payment from here on carries the real time.
update payments
   set paid_at = created_at
 where paid_at is null
   and status in ('SUCCESS', 'REFUNDED', 'DISPUTED');

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 64, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
