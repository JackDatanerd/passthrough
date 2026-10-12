-- Partners / referral program, round 10.
--
-- G1 (attribution): a referral code lived ONLY in the visitor's browser. A visitor who clicked a partner's link on
-- their phone and bought on a laptop (or cleared site data, or used an in-app browser that blocks storage) was never
-- credited. The account now remembers the code the person arrived with: users.referred_by_code / referred_at. The
-- SPA restores it into its own attribution store on sign-in, so quotes and checkout keep using ONE code path.
alter table users
  add column if not exists referred_by_code text,
  add column if not exists referred_at      timestamptz;

-- G7 (attribution source): how the code reached the checkout — a shared link, typed by hand, or restored from the
-- account. Written on the payment at checkout, copied to the ledger row when the commission is recorded, shown to the
-- admin next to each conversion. Nullable: rows from before this migration have no source.
alter table payments
  add column if not exists referral_source text;
alter table commission_ledger
  add column if not exists attribution_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_referral_source_check') then
    alter table payments add constraint payments_referral_source_check
      check (referral_source is null or referral_source in ('link', 'typed', 'account'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'commission_ledger_attribution_source_check') then
    alter table commission_ledger add constraint commission_ledger_attribution_source_check
      check (attribution_source is null or attribution_source in ('link', 'typed', 'account'));
  end if;
end $$;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 79, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
