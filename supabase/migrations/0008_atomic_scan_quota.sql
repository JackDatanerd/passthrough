-- Atomic conditional increment for the daily free-scan quota — same shape
-- as redeem_free_fix_credit (0006). The old check-then-write in
-- scan.controller.js's createScan (SELECT scans_today, compare in JS,
-- UPDATE scans_today + 1) had a race: two concurrent createScan requests
-- from the same user could both read a stale scans_today under the limit
-- and both be allowed through, letting one extra scan slip past
-- FREE_SCANS_PER_DAY. Low severity (worst case is one free extra scan, no
-- money/security impact) but the same class of bug the credit-redemption
-- RPC was already written to avoid, so it gets the same fix.
--
-- Handles the daily reset inline too — if scans_day_reset is before
-- p_today_midnight, the row is treated as if scans_today were 0 for this
-- check/increment, and reset atomically in the same statement. Returns
-- true if the scan was allowed (and the counter incremented), false if the
-- daily limit was already reached.
create or replace function increment_scan_count_if_under_limit(
  p_user_id uuid,
  p_limit int,
  p_today_midnight timestamptz
)
returns boolean
language plpgsql
security definer
as $$
declare
  v_rows int;
begin
  update users
  set
    scans_today     = case when scans_day_reset < p_today_midnight then 1
                           else scans_today + 1 end,
    scans_day_reset = case when scans_day_reset < p_today_midnight then now()
                           else scans_day_reset end
  where id = p_user_id
    and (
      scans_day_reset < p_today_midnight   -- stale day — always allowed, counter resets to 1
      or scans_today < p_limit             -- same day — only allowed under the limit
    );
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- Companion to the above — "return the slot" on the createScan failure
-- path (PATCH 5's rollback), without a stale-value read/write. Floored at
-- 0 so a rollback can never push the counter negative if it somehow races
-- with the hourly day-reset.
create or replace function decrement_scan_count(p_user_id uuid)
returns void
language sql
security definer
as $$
  update users set scans_today = greatest(scans_today - 1, 0) where id = p_user_id;
$$;

