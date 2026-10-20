-- Webhooks round 24 (migration 0103).
--
-- G1: a refund Paystack reports as FAILED used to be an email and nothing else. refund_failed_at is stamped on the payment (SUCCESS / DISPUTED,
--     i.e. money the merchant still owes the buyer) so Admin -> Payments can show "refund failed - redo it". Cleared when a refund of that
--     payment later processes.
-- B5: the old-open-disputes sweep rotated through DISPUTED payments with last_reconciled_at, the marker sweepReversedPayments uses to decide
--     which payments it may skip for a while - so every dispute the dispute sweep looked at was then skipped by the lost-dispute backstop.
--     dispute_checked_at is the dispute sweep's own rotation marker.
--
-- Both columns are nullable with no default, so this is safe to apply before or after the Worker: code that predates them never reads them,
-- and code that postdates them retries without them if the migration is late.

alter table payments add column if not exists refund_failed_at   timestamptz;
alter table payments add column if not exists dispute_checked_at timestamptz;

create index if not exists idx_payments_dispute_rotation
  on payments (dispute_checked_at nulls first) where status = 'DISPUTED';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (103, '0103_webhooks_round24')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 103, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 103;   -- never move the version BACKWARDS (a re-run of an older file)
