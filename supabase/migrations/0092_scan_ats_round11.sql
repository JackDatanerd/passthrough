-- Scan / ATS core, round 11.
--
-- A Badge -> Fix upgrade that failed softly (the rewrite failed outright, or nothing beat the
-- original) was meant to be compensated with a free credit, but grant_fix_credit_once is once
-- per (scan, round) and the Badge delivery that preceded the upgrade had already used round 0 -
-- so the person paid a credit, got their original back, and nothing was returned.
-- The upgrade gets its own once-only marker.

alter table scans add column if not exists upgrade_credit_granted_at timestamptz;

-- Returns true when this call granted the credit, false when the upgrade already had one.
create or replace function grant_upgrade_credit_once(p_scan_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update scans
     set upgrade_credit_granted_at = now()
   where id = p_scan_id
     and upgrade_credit_granted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$$;

revoke execute on function grant_upgrade_credit_once(uuid, uuid) from public, anon, authenticated;
grant  execute on function grant_upgrade_credit_once(uuid, uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (92, '0092_scan_ats_round11')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 92, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 92;   -- never move the version BACKWARDS (a re-run of an older file)
