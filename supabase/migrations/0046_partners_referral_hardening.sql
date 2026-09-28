-- 0046: partners / referral hardening (Section 4 deep audit).
--
-- 1. referral_code_reservations shipped in 0044 WITHOUT row level security.
--    Every other table has it (0014) so the anon key can never read or write
--    them directly; without it anyone holding the public anon key could read
--    code ids and insert/delete reservations (locking a limited code out, or
--    freeing slots to oversell one). Only the service role touches this table.
alter table referral_code_reservations enable row level security;
revoke all on referral_code_reservations from anon, authenticated;

-- 2. Usage counting that can be repaired. Previously the ledger row and the
--    uses_so_far bump were two separate writes; if the second failed, a
--    /reconcile re-run hit the ledger's unique index, returned "duplicate",
--    and never retried the bump. Existing rows default to TRUE (already
--    counted); recordConversion inserts new rows as FALSE and the RPC flips
--    the flag and bumps the counter in ONE transaction, exactly once.
alter table commission_ledger
  add column if not exists usage_counted boolean not null default true;

drop function if exists increment_referral_code_usage(uuid, uuid);

create function increment_referral_code_usage(
  p_code_id        uuid,
  p_reservation_id uuid default null,
  p_ledger_id      uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flipped int := 1;
begin
  if p_ledger_id is not null then
    update commission_ledger
       set usage_counted = true
     where id = p_ledger_id and usage_counted = false;
    get diagnostics v_flipped = row_count;
  end if;

  if v_flipped > 0 then
    update referral_codes set uses_so_far = uses_so_far + 1 where id = p_code_id;
  end if;

  if p_reservation_id is not null then
    delete from referral_code_reservations where id = p_reservation_id;
  end if;

  return v_flipped > 0;
end;
$$;

revoke execute on function increment_referral_code_usage(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid, uuid, uuid) to service_role;

-- 3. What a payout actually settled. amount_cents is what was wired; the
--    commission it closed out can differ (paid less/more than owed). Keeping
--    both makes any discrepancy visible instead of silently lost.
alter table payouts add column if not exists settled_commission_cents int;
