-- Webhooks section, independent audit round 25. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker checks the schema version and the migration ledger this records). The change itself is
-- only a rewrite of stored rows; the Worker also scrubs the same rows hourly (scrubRefundPayloads), so nothing breaks in between.
--
-- B1  refund.* payloads were stored through a DENY-list, so `refunded_by` (the merchant staff member's email), `customer_note` and
--     `merchant_note` (free text) were kept for the 400-day refund retention and shown in the admin payload viewer. The app now stores
--     an ALLOW-list (REFUND_KEEP in webhooks.controller.js). Reduce what is already stored to the same list.
--     record_refund_and_total (0053) reads only data.amount, which is kept.

update webhook_events
   set payload = jsonb_build_object(
         'event', payload -> 'event',
         'data', jsonb_strip_nulls(jsonb_build_object(
           'id',                    payload #> '{data,id}',
           'status',                payload #> '{data,status}',
           'amount',                payload #> '{data,amount}',
           'currency',              payload #> '{data,currency}',
           'transaction_reference', payload #> '{data,transaction_reference}',
           'refund_reference',      payload #> '{data,refund_reference}',
           'reference',             payload #> '{data,reference}',
           'created_at',            payload #> '{data,created_at}',
           'createdAt',             payload #> '{data,createdAt}',
           'expected_at',           payload #> '{data,expected_at}',
           'transaction',           case jsonb_typeof(payload #> '{data,transaction}')
             when 'object' then jsonb_strip_nulls(jsonb_build_object(
               'id',        payload #> '{data,transaction,id}',
               'reference', payload #> '{data,transaction,reference}',
               'amount',    payload #> '{data,transaction,amount}',
               'currency',  payload #> '{data,transaction,currency}'))
             when 'string' then payload #> '{data,transaction}'
             else null end
         )))
 where event_type like 'refund.%'
   and payload is not null
   and (payload #> '{data,refunded_by}' is not null
     or payload #> '{data,customer_note}' is not null
     or payload #> '{data,merchant_note}' is not null
     or payload #> '{data,customer}' is not null
     or payload #> '{data,authorization}' is not null
     or payload #> '{data,metadata}' is not null);

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (106, '0106_webhooks_round25')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 106, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 106;   -- never move the version BACKWARDS (a re-run of an older file)
