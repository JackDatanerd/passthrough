-- Journey audit: the compensating free credit is one credit per purchase, and it does not outlive the resume it was for.
--
-- Before this, grant_fix_credit_once was once per (scan, ROUND): a failed first run granted at round 0 and the same purchase
-- granted again at round 2 when the free retries ran out, so one failed purchase returned two credits (and a fix paid for with
-- a credit returned more than it cost). Nothing ever took a credit back either: a free retry or an owner edit that carried the
-- same resume to the Verified line left the person holding the credit that was only there to get them to it.
--
--   fix_credit_granted  a compensating credit was handed out for the current purchase (no second one until it is spent)
--   fix_credit_held     that credit is still attributed to this unverified resume (what revoke_compensation_credit takes back)

alter table scans add column if not exists fix_credit_granted boolean not null default false;
alter table scans add column if not exists fix_credit_held    boolean not null default false;

-- Existing scans: one that already granted is treated as granted; its credit is held while the delivered score is still under the line.
update scans set fix_credit_granted = true
 where (fix_credit_round is not null or upgrade_credit_granted_at is not null) and fix_credit_granted = false;
update scans set fix_credit_held = true
 where fix_credit_granted and fix_purchased and coalesce(fix_ats_score, 0) < 80 and fix_credit_held = false;

CREATE OR REPLACE FUNCTION public.grant_fix_credit_once(p_scan_id uuid, p_user_id uuid, p_round integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows int;
begin
  if p_scan_id is null or p_user_id is null or p_round is null then
    return false;
  end if;
  if not exists (select 1 from users where id = p_user_id and deleted_at is null) then
    return false;
  end if;
  -- One credit per purchase: a later round never grants again once one is out for this scan.
  update scans
     set fix_credit_round = p_round, fix_credit_granted = true, fix_credit_held = true
   where id = p_scan_id
     and user_id = p_user_id
     and fix_credit_granted = false
     and (fix_credit_round is null or fix_credit_round < p_round);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.grant_upgrade_credit_once(p_scan_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows int;
begin
  if p_scan_id is null or p_user_id is null
     or not exists (select 1 from users where id = p_user_id and deleted_at is null) then
    return false;
  end if;
  update scans
     set upgrade_credit_granted_at = now(), fix_credit_granted = true, fix_credit_held = true
   where id = p_scan_id
     and user_id = p_user_id
     and upgrade_credit_granted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$function$;

-- The resume this scan's credit was for has reached the Verified line: the credit goes. It can only take back what is still there
-- (a credit already spent elsewhere is not clawed below zero). Returns true when this call cleared the marker.
CREATE OR REPLACE FUNCTION public.revoke_compensation_credit(p_scan_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_rows int;
begin
  if p_scan_id is null or p_user_id is null then
    return false;
  end if;
  update scans set fix_credit_held = false
   where id = p_scan_id and user_id = p_user_id and fix_credit_held = true;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = greatest(free_fix_credits - 1, 0) where id = p_user_id;
  return true;
end;
$function$;

revoke execute on function grant_fix_credit_once(uuid, uuid, int)    from public, anon, authenticated;
grant  execute on function grant_fix_credit_once(uuid, uuid, int)    to service_role;
revoke execute on function grant_upgrade_credit_once(uuid, uuid)     from public, anon, authenticated;
grant  execute on function grant_upgrade_credit_once(uuid, uuid)     to service_role;
revoke execute on function revoke_compensation_credit(uuid, uuid)    from public, anon, authenticated;
grant  execute on function revoke_compensation_credit(uuid, uuid)    to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (121, '0121_credit_one_per_purchase')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 121, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 121;   -- never move the version BACKWARDS (a re-run of an older file)
