-- Webhooks round 16 (B1): when did a webhook_events row last START being worked on?
--
-- received_at is the FIRST receipt and never moves. A FAILED row that Paystack redelivered, an admin replayed, or the hourly
-- re-drive picked up became RECEIVED with its old received_at — "stuck" the instant it was picked up. Replay/Dismiss were offered
-- for an event that was running, the attention list and the dashboard counted it, and the re-drive ran it alongside the live
-- delivery (double alerts, double Paystack calls, a re-drive attempt spent for nothing).
--
-- last_attempt_at is stamped by every pickup (live redelivery, replay, re-drive). Every "is this stuck / stale?" test reads it.
-- NOT NULL DEFAULT now(): a first-time delivery starts it at its receipt time with no code involved, and the `<` comparisons the
-- re-drive and the attention list make never meet a NULL.
--
-- Apply BEFORE deploying the Worker (the Worker tolerates the column being absent and falls back to received_at, but the
-- retry-looks-stuck bug stays until it exists).

alter table webhook_events add column if not exists last_attempt_at timestamptz not null default now();

-- Existing rows: the best available answer is their first receipt (adding the column stamped them with the migration time).
update webhook_events set last_attempt_at = received_at where last_attempt_at is distinct from received_at;

-- Webhooks round 16 (G1): the id Paystack gave the evidence sent for a dispute, stored as '<disputeId>:<evidenceId>' so it is only ever
-- quoted for the dispute it belongs to. Paystack requires it when a fraud-claim dispute is resolved (contest).
alter table payments add column if not exists dispute_evidence_id text;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (90, '0090_webhooks_round16')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 90, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 90;   -- never move the version BACKWARDS (a re-run of an older file)
