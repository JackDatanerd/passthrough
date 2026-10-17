-- Webhooks round 19 (G2). Records the merchant's own answer to a dispute, so the deadline pages and Admin -> Payments can tell
-- "unanswered" from "answered, waiting on the bank". Written by contest / accept (and by a resolution that leaves the payment
-- waiting on a person); reset when a new dispute marks the payment DISPUTED. Additive, nullable: the Worker runs without it.
alter table payments add column if not exists dispute_answered_at timestamptz;
alter table payments add column if not exists dispute_answer      text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'payments_dispute_answer_check') then
    alter table payments add constraint payments_dispute_answer_check
      check (dispute_answer is null or dispute_answer in ('contested', 'accepted', 'resolved'));
  end if;
end $$;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (97, '0097_webhooks_round19')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 97, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 97;   -- never move the version BACKWARDS (a re-run of an older file)
