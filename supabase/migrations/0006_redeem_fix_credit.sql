-- Atomic conditional decrement for redeeming a free fix credit — the WHERE
-- free_fix_credits > 0 guard combined with a single UPDATE statement means
-- two concurrent redeem requests can't both succeed off a stale read (the
-- same race increment_free_fix_credits was written to avoid, just in the
-- other direction). Returns true if a credit was actually consumed, false
-- if there were none available.
create or replace function redeem_free_fix_credit(p_user_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_rows int;
begin
  update users
  set free_fix_credits = free_fix_credits - 1
  where id = p_user_id and free_fix_credits > 0;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
