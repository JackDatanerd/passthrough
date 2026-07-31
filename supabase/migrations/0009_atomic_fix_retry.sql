-- Atomic conditional increment for the "Try Again" fix-retry counter — same
-- shape as redeem_free_fix_credit (0006) and increment_scan_count_if_under_limit
-- (0008). scan.controller.js's retryFix previously did a plain JS
-- read-then-write (SELECT fix_retry_count, compare in JS, UPDATE
-- fix_retry_count + 1), the exact class of race those two migrations were
-- written to close — just left unfixed here. Two concurrent retry requests
-- (double-click, a retry fired from two tabs, a flaky-network client retry)
-- could both read the same stale fix_retry_count, both pass the
-- < MAX_FIX_RETRIES check, and both enqueue a generateFix job against the
-- same scan — exceeding the intended retry cap and running two generations
-- concurrently against one row.
--
-- Folds every gating condition retryFix needs into the WHERE clause of a
-- single UPDATE, so only a request that finds the row in exactly the right
-- state at the moment of the update can ever succeed — the same atomicity
-- guarantee UPDATE...RETURNING gives the payment-idempotency code elsewhere.
-- Returns the NEW fix_retry_count on success, or -1 if no row matched
-- (already at the retry cap, already reached the badge threshold, not in
-- FIX_DELIVERED, or a concurrent request won the race first).
create or replace function increment_fix_retry_if_available(
  p_scan_id uuid,
  p_max_retries int,
  p_badge_threshold int
)
returns int
language plpgsql
security definer
as $$
declare
  v_new_count int;
begin
  update scans
  set fix_retry_count = fix_retry_count + 1,
      status          = 'FIX_GENERATING'
  where id = p_scan_id
    and status = 'FIX_DELIVERED'
    and fix_retry_count < p_max_retries
    and (fix_ats_score is null or fix_ats_score < p_badge_threshold)
  returning fix_retry_count into v_new_count;

  return coalesce(v_new_count, -1);
end;
$$;
