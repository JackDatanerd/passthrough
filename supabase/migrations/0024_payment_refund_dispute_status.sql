-- 0024_payment_refund_dispute_status.sql
-- Section 8 (Webhooks) audit — refunds and chargebacks were alert-only:
-- pay_status_enum had no value that could describe them, so a refunded or
-- disputed payment stayed 'SUCCESS' forever (still counted as revenue, still
-- entitled to commission, still carrying a live public credential).
--
-- Kept in its OWN migration file on purpose: Postgres cannot use a newly
-- added enum value in the same transaction that adds it, and Supabase's SQL
-- editor may run a whole file as one transaction. Run this file first, on its
-- own, THEN run 0025 (which does not reference the new values, but the app
-- code that ships with it does).

alter type pay_status_enum add value if not exists 'REFUNDED';
alter type pay_status_enum add value if not exists 'DISPUTED';
