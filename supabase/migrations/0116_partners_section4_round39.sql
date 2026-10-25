-- Partners / Referral program, section 4 round 39 (migration 0116). Additive and idempotent. Service role only, like every other table here.
--
-- 1. partner_code_requests: "I'd like a code of my own" used to exist only as an owner alert email. If that mail failed (provider outage,
--    throttle) the request was gone and the partner had been told it was received. It is now a row the admin panel lists, and the alert
--    is only a nudge.
-- 2. purge_unlinked_terms_acceptances(): partner_terms_acceptances rows logged at application time carry only application_email (no
--    partner_id). When the application was purged (rejected + 90 days) or the partner erased, those rows - email, IP hash, user agent -
--    were never removed. This removes every unlinked row whose application no longer exists. Called hourly by the retention sweep.
-- 3. commission_ledger_giveback_once: a full reversal hands back what earlier partial adjustments took. The give-back is now retried on
--    redelivery, so it must be insertable at most once per sale (the sale's own partial adjustments are all negative, a give-back is the
--    only positive row tied to a sale).

create table if not exists partner_code_requests (
  id           uuid primary key default gen_random_uuid(),
  partner_id   uuid not null references partners(id) on delete cascade,
  wanted_code  text,
  note         text,
  status       text not null default 'OPEN' check (status in ('OPEN', 'DONE', 'DISMISSED')),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create unique index if not exists partner_code_requests_one_open_idx on partner_code_requests (partner_id) where status = 'OPEN';
create index if not exists partner_code_requests_status_idx on partner_code_requests (status, created_at desc);
alter table partner_code_requests enable row level security;

create or replace function purge_unlinked_terms_acceptances(p_batch int default 1000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  with d as (
    select t.id from partner_terms_acceptances t
     where t.partner_id is null
       and t.accepted_at < now() - interval '1 day'      -- an application being filed right now has its row a moment after the log
       and not exists (select 1 from partner_applications a where lower(a.email) = lower(t.application_email))
     limit greatest(p_batch, 1)
  )
  delete from partner_terms_acceptances x using d where x.id = d.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke execute on function purge_unlinked_terms_acceptances(int) from public, anon, authenticated;
grant  execute on function purge_unlinked_terms_acceptances(int) to service_role;

create unique index if not exists commission_ledger_giveback_once on commission_ledger (adjusts_ledger_id)
  where kind = 'ADJUSTMENT' and adjusts_ledger_id is not null and commission_amount_cents > 0;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (116, '0116_partners_section4_round39')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 116, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 116;   -- never move the version BACKWARDS (a re-run of an older file)
