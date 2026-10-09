-- Webhooks, audit round 7 (Section 8). Idempotent — safe to re-run.
--
-- The application degrades if this has not been applied yet (the re-drive falls back to its old
-- `attempts` budget), but apply it before relying on: the separate re-drive counter, and the stored
-- card tokens / dispute conversations being gone.
--
-- B3  webhook_events.redrives — how many times the HOURLY RE-DRIVE has re-run a row. The cap used
--     `attempts`, which every Paystack redelivery also increments, so a failing event used the budget
--     up on Paystack's own retries and was announced as abandoned while Paystack was still trying.
--     Rows the old cap had already exhausted start at 0 and are re-driven again, which is the point.
-- G3  payments.paystack_auth_code — the reusable card token. Nothing ever read it back (round 6 had
--     already stopped keeping it in the stored webhook payloads); the app no longer writes it. Clear
--     the ones already saved.
-- G4  charge.dispute.* payloads kept the whole dispute (messages, history, attachments, the customer's
--     words). The handler uses a handful of fields; the app now stores only those. Reduce what is
--     already stored to the same allowlist (see DISPUTE_KEEP in webhooks.controller.js).
-- G1  needs no schema: the Resend inbox uses webhook_events with provider = 'resend' (the unique
--     (provider, event_key) index and the status check from 0025 already cover it).

alter table webhook_events add column if not exists redrives int not null default 0;

update payments set paystack_auth_code = null where paystack_auth_code is not null;

update webhook_events
   set payload = jsonb_build_object(
         'event', payload -> 'event',
         'data', jsonb_strip_nulls(jsonb_build_object(
           'id',                    payload #> '{data,id}',
           'status',                payload #> '{data,status}',
           'resolution',            payload #> '{data,resolution}',
           'refund_amount',         payload #> '{data,refund_amount}',
           'currency',              payload #> '{data,currency}',
           'category',              payload #> '{data,category}',
           'reference',             payload #> '{data,reference}',
           'transaction_reference', payload #> '{data,transaction_reference}',
           'due_at',                payload #> '{data,due_at}',
           'resolved_at',           payload #> '{data,resolved_at}',
           'created_at',            payload #> '{data,created_at}',
           'transaction',           jsonb_strip_nulls(jsonb_build_object(
             'id',        payload #> '{data,transaction,id}',
             'reference', payload #> '{data,transaction,reference}',
             'amount',    payload #> '{data,transaction,amount}',
             'currency',  payload #> '{data,transaction,currency}'))
         )))
 where event_type like 'charge.dispute%' and payload is not null;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 65, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
