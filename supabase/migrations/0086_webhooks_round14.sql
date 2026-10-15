-- Webhooks section, independent audit round 14. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version and the migration ledger this records).
-- The old Worker keeps working against this migration: every change is an added, nullable column.
--
-- 1. payments.reversal_notice_sent_at — the CLAIM that makes the buyer's "your payment was reversed" email go out exactly once.
--    It used to ride on "this call moved the payment to REFUNDED", so a first attempt that flipped the status and then threw
--    (the commission or the credential step) was retried by Paystack with `transitioned = false` and the buyer was never told.
--    Rows that are REFUNDED already were told (or never will be): they are stamped so an old refund event that is replayed
--    does not mail a refund notice months late.
--
-- 2. payments.dispute_id — Paystack's id for the dispute, written when charge.dispute.create / .remind is processed. The admin
--    "Accept dispute" / "Submit evidence" actions call Paystack's dispute API with it. Nothing personal.
--
-- 3. users.email_bounced_at / email_bounce_type — the account's address is one Resend reported as a spam complaint, a permanent
--    bounce or a suppressed send. Security and payment mail still goes to it (see lib/emailSuppression.js) and will keep
--    failing; the SPA now says so, and Admin → Users shows it. Cleared when the person changes their address or an admin lifts
--    the suppression. A class and a time only — never the address (which is the account's own `email`).
--
-- 4. webhook_events.processing_ms — how long the handler took, so a delivery that comes close to Paystack's timeout (the work is
--    done BEFORE the 200) can be seen and alerted on instead of surfacing as unexplained redeliveries.
--
-- 5. A partial index for the retention scrub of Resend payloads (they hold recipient addresses and are only needed while an
--    event is unfinished).

alter table payments add column if not exists reversal_notice_sent_at timestamptz;

update payments
   set reversal_notice_sent_at = coalesce(refunded_at, now())
 where status = 'REFUNDED' and reversal_notice_sent_at is null;

alter table payments add column if not exists dispute_id text;

alter table users add column if not exists email_bounced_at timestamptz;
alter table users add column if not exists email_bounce_type text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_email_bounce_type_check') then
    alter table users add constraint users_email_bounce_type_check
      check (email_bounce_type is null or email_bounce_type in ('complaint', 'bounce', 'suppressed'));
  end if;
end $$;

alter table webhook_events add column if not exists processing_ms int;

create index if not exists idx_webhook_events_resend_payload
  on webhook_events (received_at) where provider = 'resend' and payload is not null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (86, '0086_webhooks_round14')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 86, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 86;   -- never move the version BACKWARDS (a re-run of an older file)
