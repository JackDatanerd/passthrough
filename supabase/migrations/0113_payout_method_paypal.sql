-- Western-market round: partners anywhere can be paid by PayPal as well as by bank transfer or mobile money.
-- Country-specific bank routing details (ACH routing number, UK sort code, AU BSB, CA transit number, IBAN, SWIFT/BIC) are stored
-- inside the existing payout_details jsonb, so only the enum needs a new value. The value is not used in this migration (a new enum
-- value cannot be used in the transaction that adds it); application code starts writing it after deploy.
alter type payout_method_enum add value if not exists 'PAYPAL';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (113, '0113_payout_method_paypal')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 113, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 113;   -- never move the version BACKWARDS (a re-run of an older file)
