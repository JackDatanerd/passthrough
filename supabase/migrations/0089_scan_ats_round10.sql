-- Scan/ATS round 10: hardening of the fix-job RPCs from 0057, and the marker for Badge -> Fix upgrades.
--
-- 1. release_fix_job was not owner-scoped. A job that outlived its lease (a slow rewrite, a stalled
--    render) and then finished released the lease a SECOND job had since taken, letting a third start
--    on top of it. A job now identifies itself with a token: claim_fix_job stores it with the lease and
--    release_fix_job only clears a lease that is still the caller's. Both new parameters default to
--    NULL, so a worker that has not been redeployed yet keeps working unchanged (NULL token = the
--    old, unconditional behaviour). Apply this migration BEFORE deploying the worker.
--
-- 2. grant_fix_credit_once recorded the round as granted and only then updated users; with no such
--    user row the round was consumed and no credit was ever given. It now checks the user exists
--    first and returns false without touching the scan.
--
-- 3. badge_upgraded_at: a Badge (credential-only) purchase can be upgraded to a full Fix on the SAME scan by
--    spending a free fix credit (POST /scan/:id/upgrade-to-fix). The column marks a scan whose upgrade run is in
--    flight; generateFix clears it on delivery, and uses it to revert the tier and hand the credit back if the
--    run crashes, so a failed upgrade can never leave a spent credit and no fix.
--
-- 4. fix_retry_no_gain: a Try Again round whose rewrites all scored no better than the delivery already held
--    re-delivers that same content. The flag lets the results page say so instead of presenting an unchanged
--    resume as a fresh result. Written best-effort AFTER delivery, so it can never block one.

alter table scans add column if not exists fix_job_lock_token uuid;
alter table scans add column if not exists badge_upgraded_at   timestamptz;
alter table scans add column if not exists fix_retry_no_gain   boolean not null default false;

drop function if exists claim_fix_job(uuid, int);
drop function if exists release_fix_job(uuid);

create or replace function claim_fix_job(p_scan_id uuid, p_lease_seconds int, p_token uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update scans
     set fix_job_lock_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         fix_job_lock_token = p_token
   where id = p_scan_id
     and (fix_job_lock_until is null or fix_job_lock_until < now());
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Clears the lease only if it is still this caller's (or the caller sent no token, or the lease
-- predates tokens). A job whose lease expired and was re-claimed finds a different token and leaves
-- the new holder's lease alone.
create or replace function release_fix_job(p_scan_id uuid, p_token uuid default null)
returns void
language sql
security definer
set search_path = public
as $$
  update scans
     set fix_job_lock_until = null,
         fix_job_lock_token = null
   where id = p_scan_id
     and (p_token is null or fix_job_lock_token is null or fix_job_lock_token = p_token);
$$;

create or replace function grant_fix_credit_once(p_scan_id uuid, p_user_id uuid, p_round int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if not exists (select 1 from users where id = p_user_id) then
    return false;
  end if;
  update scans
     set fix_credit_round = p_round
   where id = p_scan_id
     and (fix_credit_round is null or fix_credit_round < p_round);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$$;

revoke execute on function claim_fix_job(uuid, int, uuid)        from public, anon, authenticated;
revoke execute on function release_fix_job(uuid, uuid)           from public, anon, authenticated;
revoke execute on function grant_fix_credit_once(uuid, uuid, int) from public, anon, authenticated;
grant  execute on function claim_fix_job(uuid, int, uuid)        to service_role;
grant  execute on function release_fix_job(uuid, uuid)           to service_role;
grant  execute on function grant_fix_credit_once(uuid, uuid, int) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (89, '0089_scan_ats_round10')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 89, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 89;   -- never move the version BACKWARDS (a re-run of an older file)
