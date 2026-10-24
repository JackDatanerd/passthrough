-- Tax IDs are now stored sealed (AES-GCM, see src/lib/fieldCrypto.js): "enc:v1:<iv>:<ciphertext>" is longer than the 40 characters a
-- plain tax ID was limited to. The 40-character limit is still enforced on what a partner TYPES (the API schema); this check only has to
-- hold a sealed value, so it allows up to 400. Existing plain-text rows stay valid and are sealed by scripts/encrypt-tax-ids.cjs.
alter table partners drop constraint if exists partners_tax_id_check;
alter table partners add constraint partners_tax_id_check check (tax_id is null or char_length(tax_id) between 3 and 400);

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (114, '0114_tax_id_sealed')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 114, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 114;   -- never move the version BACKWARDS (a re-run of an older file)
