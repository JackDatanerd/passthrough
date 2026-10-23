-- Partners / Referral program, section 4 round 33 (migration 0112). Additive and idempotent.
--
-- partners_overview_totals: the admin Partners overview strip needs four money totals. The Worker used to page through EVERY payout and
-- EVERY commission_ledger row (twice) on each load; past a few hundred thousand rows that exceeds a Worker's subrequest budget. One
-- aggregate query returns them. The Worker falls back to the old scan if this function is missing, so deploy order does not matter.
--   paid_out_cents             payouts not voided
--   lifetime_commission_cents  every ledger row (sales, reversals, adjustments), net
--   owed_cents                 sum of the partners whose unpaid ledger nets POSITIVE
--   credit_cents               sum of the partners whose unpaid ledger nets NEGATIVE (a refund credit), as a positive number
-- p_exclude_partner leaves the internal welcome-code partner out.

create or replace function partners_overview_totals(p_exclude_partner uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with unpaid as (
    select partner_id, sum(commission_amount_cents)::bigint as s
      from commission_ledger
     where payout_id is null
       and (p_exclude_partner is null or partner_id <> p_exclude_partner)
     group by partner_id)
  select jsonb_build_object(
    'paid_out_cents',            coalesce((select sum(amount_cents)::bigint from payouts where voided_at is null), 0),
    'lifetime_commission_cents', coalesce((select sum(commission_amount_cents)::bigint from commission_ledger
                                            where p_exclude_partner is null or partner_id <> p_exclude_partner), 0),
    'owed_cents',                coalesce((select sum(s) from unpaid where s > 0), 0),
    'credit_cents',              coalesce((select sum(-s) from unpaid where s < 0), 0));
$$;

revoke execute on function partners_overview_totals(uuid) from public, anon, authenticated;
grant  execute on function partners_overview_totals(uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (112, '0112_partners_section4_round33')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 112, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 112;   -- never move the version BACKWARDS (a re-run of an older file)
