-- SECTION 8 (Webhooks) audit, fresh pass — bug fix.
--
-- webhooks.controller.js's processRefund decides a sale is fully refunded by
-- summing every already-PROCESSED refund.processed row for the transaction
-- (refundedSoFar, now removed) and adding this event's own amount on top —
-- a plain JS read, then a JS decision, with nothing serializing it against a
-- concurrent read for the SAME payment.
--
-- Two DISTINCT partial refunds on one transaction (e.g. two 50% refunds),
-- delivered close enough together to be picked up by two concurrent Worker
-- invocations, could each read the total BEFORE the other's event row was
-- marked PROCESSED. Both would compute a total under the full amount and
-- return "partial — alerted"; NEITHER would ever call reversePayment, even
-- though together the two refunds are a complete one. Not silent — each
-- partial still fires an alert telling an admin to check manually, and
-- reversePayment is itself idempotent so there's no double-reversal risk —
-- but it defeats the exact scenario the "SUMMED" fix (0036/round 3) exists
-- to catch, the moment two refund events aren't processed strictly
-- sequentially.
--
-- This folds the same "sum the inbox" into one Postgres call: lock the
-- payment row first (serializing concurrent calls for the SAME payment),
-- mark THIS event's own webhook_events row PROCESSED, THEN sum every
-- PROCESSED refund.processed row for the reference. A concurrent sibling,
-- once it gets the lock (released when this call's transaction commits),
-- always sees this one already counted. It is a SUM over source rows, not
-- an accumulator column, so re-running it for the same event id is a no-op
-- on the total either way — recordEvent's (provider, event_key) uniqueness
-- already keeps a genuine redelivery from ever reaching this function
-- twice; this is just insurance, not a second dedupe mechanism.
--
-- Same conventions as every other RPC in this schema (increment_fix_retry_if_available,
-- increment_verification_views, etc.): security definer, search_path pinned per 0015.
create or replace function record_refund_and_total(
  p_payment_id uuid,
  p_reference  text,
  p_event_id   uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int;
begin
  -- Row lock: a concurrent call for the SAME payment blocks here until this
  -- transaction commits, then sees this event already marked PROCESSED below.
  perform 1 from payments where id = p_payment_id for update;

  update webhook_events
  set status = 'PROCESSED', processed_at = now()
  where id = p_event_id;

  select coalesce(sum((payload->'data'->>'amount')::numeric), 0)::int into v_total
  from webhook_events
  where event_type = 'refund.processed' and reference = p_reference and status = 'PROCESSED';

  return coalesce(v_total, 0);
end;
$$;
