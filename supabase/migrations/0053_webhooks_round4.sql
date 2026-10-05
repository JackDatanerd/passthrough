-- Webhooks, audit round 4 (Section 8). Idempotent — safe to re-run.
--
-- Fixes B1 + B3 in webhooks.controller.js's refund handling.
--
-- B1  record_refund_and_total (0042) used to mark the event's inbox row PROCESSED *before*
--     the caller had reversed anything. If reversePayment then threw — and the same database
--     blip stopped markEvent from recording FAILED — the row stayed PROCESSED, the 500 made
--     Paystack redeliver, recordEvent answered "done", and the hourly re-drive (FAILED/RECEIVED
--     only) never looked at it: a paid-back sale stayed SUCCESS forever. The function now only
--     RECORDS the refund amount; the controller marks the event PROCESSED after the work.
-- B3  The running refund total was a SUM over webhook_events rows, which the daily prune
--     deletes after 90 days — a later partial refund then saw an understated total and never
--     reversed the sale. Refund amounts now live in their own table, which is never pruned.

create table if not exists payment_refunds (
  id           uuid primary key default gen_random_uuid(),
  payment_id   uuid        not null references payments(id) on delete cascade,
  event_key    text        not null,          -- webhook_events.event_key of the refund.processed that reported it
  amount_cents bigint      not null check (amount_cents >= 0),
  created_at   timestamptz not null default now(),
  unique (payment_id, event_key)
);
create index if not exists payment_refunds_payment_idx on payment_refunds (payment_id);
alter table payment_refunds enable row level security;   -- service-role only, like every other table (see 0014)

-- Backfill from the inbox rows the old function summed (PROCESSED refund.processed events),
-- so a refund total in flight across this migration is not lost. Non-numeric amounts are skipped.
insert into payment_refunds (payment_id, event_key, amount_cents)
select p.id, we.event_key, round((we.payload->'data'->>'amount')::numeric)::bigint
  from webhook_events we
  join payments p on p.paystack_ref = we.reference
 where we.event_type = 'refund.processed'
   and we.status = 'PROCESSED'
   and (we.payload->'data'->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
on conflict (payment_id, event_key) do nothing;

-- New signature (adds p_count), so the 0042 three-argument version must go: with a default on
-- the new argument a three-argument call would otherwise match both and fail as ambiguous.
drop function if exists record_refund_and_total(uuid, text, uuid);

-- Locks the payment row (serialising concurrent refund events for the SAME payment), records
-- this event's amount once (unique (payment_id, event_key) makes a redelivery a no-op), and
-- returns the total refunded so far. It never touches webhook_events.status.
-- p_count = false returns the total WITHOUT recording this event: used for a refund event that
-- carries no id of any kind, where a duplicate delivery cannot be told from a second refund.
create or replace function record_refund_and_total(
  p_payment_id uuid,
  p_reference  text,
  p_event_id   uuid,
  p_count      boolean default true
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key    text;
  v_raw    text;
  v_total  bigint;
begin
  perform 1 from payments where id = p_payment_id for update;

  if p_count and p_event_id is not null then
    select event_key, payload->'data'->>'amount' into v_key, v_raw
      from webhook_events where id = p_event_id;
    if v_key is not null and v_raw ~ '^[0-9]+(\.[0-9]+)?$' then
      insert into payment_refunds (payment_id, event_key, amount_cents)
      values (p_payment_id, v_key, round(v_raw::numeric)::bigint)
      on conflict (payment_id, event_key) do nothing;
    end if;
  end if;

  select coalesce(sum(amount_cents), 0) into v_total from payment_refunds where payment_id = p_payment_id;
  return v_total;
end;
$$;

-- The 0042 function was left at the default EXECUTE grant, i.e. callable by anon/authenticated
-- through PostgREST. Lock it down like every other RPC here (see 0023).
revoke execute on function record_refund_and_total(uuid, text, uuid, boolean) from public, anon, authenticated;
grant  execute on function record_refund_and_total(uuid, text, uuid, boolean) to service_role;
