-- Scan/ATS round: two guards for the queue-driven fix jobs.
--
-- 1. fix_job_lock_until / claim_fix_job / release_fix_job
--    generateFix and generateBadge only skipped a job whose scan was already FIX_DELIVERED. Two
--    deliveries of the same job at once (an admin requeue racing the failed-fix sweep, a platform
--    redelivery) both ran: two sets of Claude calls, two uploads (the loser's R2 objects were
--    never referenced, so never deleted) and two e-mails. A job now takes a short lease on the
--    scan first; a second one finds it held and stands down. The lease expires on its own, so a
--    crashed job can never wedge a scan.
--
-- 2. fix_credit_round / grant_fix_credit_once
--    The compensating free credit (a total rewrite failure, retries exhausted below the
--    threshold, a Badge whose delivered file missed the threshold) was granted by a bare
--    increment AFTER the work: a job that crashed after granting and was re-run granted again.
--    The credit is now granted at most once per (scan, round), in one statement.

alter table scans add column if not exists fix_job_lock_until timestamptz;
alter table scans add column if not exists fix_credit_round   int;

create or replace function claim_fix_job(p_scan_id uuid, p_lease_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update scans
     set fix_job_lock_until = now() + make_interval(secs => greatest(p_lease_seconds, 1))
   where id = p_scan_id
     and (fix_job_lock_until is null or fix_job_lock_until < now());
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function release_fix_job(p_scan_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update scans set fix_job_lock_until = null where id = p_scan_id;
$$;

-- Returns true when this call granted the credit, false when this round already had one.
create or replace function grant_fix_credit_once(p_scan_id uuid, p_user_id uuid, p_round int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
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

revoke execute on function claim_fix_job(uuid, int)              from public, anon, authenticated;
revoke execute on function release_fix_job(uuid)                  from public, anon, authenticated;
revoke execute on function grant_fix_credit_once(uuid, uuid, int) from public, anon, authenticated;
grant  execute on function claim_fix_job(uuid, int)              to service_role;
grant  execute on function release_fix_job(uuid)                  to service_role;
grant  execute on function grant_fix_credit_once(uuid, uuid, int) to service_role;
