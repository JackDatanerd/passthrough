-- Webhooks section, independent audit round 13. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version and the migration ledger this records).
--
-- 1. payments.dispute_due_at — when Paystack auto-accepts a dispute that nobody answered (the `due_at` of the dispute payload).
--    It was kept in the webhook inbox and quoted once in the owner alert, but nowhere an admin working through Payments could see
--    it: a DISPUTED row showed only when it was opened. The Worker writes it on charge.dispute.create / .remind and reads it for the
--    Payments list and the dashboard's "open disputes" card. A value on a row that is no longer DISPUTED is meaningless and is never
--    shown; it is overwritten by the next dispute. Nothing personal — not scrubbed on account deletion (listed in KEPT on purpose).
--
-- 2. A partial index over the open disputes, ordered by deadline: the dashboard asks "how many, and which is due first" on every load.

alter table payments add column if not exists dispute_due_at timestamptz;

create index if not exists idx_payments_open_disputes
  on payments (dispute_due_at nulls last) where status = 'DISPUTED';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (83, '0083_webhooks_round13')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 83, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 83;   -- never move the version BACKWARDS (a re-run of an older file)
