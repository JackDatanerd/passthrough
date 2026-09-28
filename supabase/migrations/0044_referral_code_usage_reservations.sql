-- 0044_referral_code_usage_reservations.sql
-- Section 3/4 audit pass (this round), feature gap — closes the usage-limit
-- race referral.service.js's file-level comment has documented (and
-- deliberately deferred) for several rounds: isCodeUsable()'s usage_limit
-- check only ever looked at uses_so_far, which is only incremented on a
-- COMPLETED conversion (recordConversion, at the end of checkout) — never at
-- the moment a checkout actually STARTS (initializePayment). Between those
-- two moments, every concurrent shopper who opens checkout sees the same
-- "not yet at the limit" snapshot, so a single-use code shared in a burst
-- could be legitimately redeemed far past its usage_limit before any of
-- those checkouts finished paying. The previous mitigation (warnIfOverLimit)
-- only ever told the owner AFTER the fact — real money already moved, real
-- commission already owed, nothing left to prevent.
--
-- Fix shape: an explicit, atomic RESERVATION taken at initializePayment time
-- (before Paystack is ever called, so the discounted amount charged always
-- matches whatever reservation outcome decided it), released the instant a
-- checkout stops being live (cancelled, abandoned, sweep-timed-out, or the
-- Paystack call/DB insert itself failed) and consumed (folded into
-- uses_so_far) the instant it actually converts. A held reservation counts
-- toward the limit exactly like an already-completed use does, closing the
-- exact window described above.
--
-- Deliberately a SEPARATE table rather than a mutable counter column on
-- referral_codes: a plain "reserved_count int" would need a perfect
-- increment/decrement at every single call site that can end a checkout
-- (there are several — see payments.controller.js and reconcile.service.js)
-- and any missed release path would silently and PERMANENTLY leak capacity
-- off a real partner's code with no way to notice. A row-per-reservation
-- table is self-healing instead: reserve_referral_code_slot()'s own count
-- only considers reservations younger than its TTL, so even a release path
-- this pass somehow missed can only ever cost the partner a few unusable
-- slots for at most that TTL window, never forever — and the reservations
-- table is still explicitly pruned (see referral.service.js's
-- pruneReferralCodeReservations, run from the existing hourly stale-pending
-- sweep) so it never grows without bound.
create table if not exists referral_code_reservations (
  id                uuid primary key default gen_random_uuid(),
  referral_code_id  uuid not null references referral_codes(id) on delete cascade,
  created_at        timestamptz not null default now()
);

-- Every live-checkout query below is "how many reservations exist for THIS
-- code, and how new are they" — a composite index on exactly those two
-- columns is what both reserve_referral_code_slot() and the prune job need.
create index if not exists referral_code_reservations_code_created_idx
  on referral_code_reservations (referral_code_id, created_at);

-- payments.referral_reservation_id: which reservation (if any) this specific
-- payment is holding, so cancelPayment / the stale-abandon paths / the hourly
-- sweeps can release the RIGHT row instead of guessing. `on delete set null`
-- (not cascade) — a payment row is history and must survive its reservation
-- being pruned/released; the reservation is transient bookkeeping, the
-- payment is the permanent record.
alter table payments
  add column if not exists referral_reservation_id uuid references referral_code_reservations(id) on delete set null;

-- TTL rationale: 3600s deliberately covers the longest window in which a
-- PENDING checkout can still legitimately convert — initializePayment's 30-min
-- resume window and sweepPendingPayments' 60-min recovery window
-- (reconcile.service.js) — so a live checkout never loses its slot to a
-- second shopper while it can still be paid. Only a row whose release path
-- never ran is ever affected by the TTL.
--
-- Atomic check-and-reserve. `for update` on the referral_codes row is what
-- actually closes the race: it serializes concurrent callers reserving the
-- SAME code, so the count-then-insert below can never both see room for the
-- same last slot the way two independent read-then-write calls could.
-- Returns the new reservation's id on success, or null if the code has no
-- room left (caller falls back to standard/promo pricing exactly like an
-- already-exhausted code has always silently done — see
-- referral.service.js's reserveCodeUsage). A code with no usage_limit at all
-- skips the count entirely (nothing to enforce) but still records a
-- reservation row, so the accounting stays uniform for the release/consume
-- side regardless of whether a limit is set.
create or replace function reserve_referral_code_slot(p_code_id uuid, p_ttl_seconds int default 3600)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit  int;
  v_used   int;
  v_active int;
  v_id     uuid;
begin
  select usage_limit, uses_so_far into v_limit, v_used
    from referral_codes where id = p_code_id
    for update;

  if not found then
    return null;
  end if;

  if v_limit is not null then
    select count(*) into v_active
      from referral_code_reservations
      where referral_code_id = p_code_id
        and created_at > now() - make_interval(secs => p_ttl_seconds);

    if (v_used + v_active) >= v_limit then
      return null;
    end if;
  end if;

  insert into referral_code_reservations (referral_code_id) values (p_code_id)
    returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function reserve_referral_code_slot(uuid, int) from public, anon, authenticated;
grant  execute on function reserve_referral_code_slot(uuid, int) to service_role;

-- Best-effort release for a checkout that stopped being live without
-- converting (cancelled, abandoned, timed out, or never made it past the
-- Paystack call / payments insert). A no-op if the reservation is already
-- gone (already released, already consumed, already pruned) — callers never
-- need to check existence first.
create or replace function release_referral_code_slot(p_reservation_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from referral_code_reservations where id = p_reservation_id;
$$;

revoke execute on function release_referral_code_slot(uuid) from public, anon, authenticated;
grant  execute on function release_referral_code_slot(uuid) to service_role;

-- increment_referral_code_usage now also releases the reservation it's
-- consuming, in the SAME statement/transaction as the uses_so_far bump —
-- doing these as two separate calls would leave a window where a payment
-- has been counted as a real use AND its now-redundant reservation still
-- counts toward v_active above, double-counting this one conversion against
-- the limit until the reservation's TTL naturally lapses. p_reservation_id
-- is optional (defaults null) so a caller with no reservation to release
-- (a payment that predates this migration, or one whose code had no
-- usage_limit and never needed one tracked) can still call this unchanged.
drop function if exists increment_referral_code_usage(uuid);

create function increment_referral_code_usage(p_code_id uuid, p_reservation_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update referral_codes set uses_so_far = uses_so_far + 1 where id = p_code_id;
  if p_reservation_id is not null then
    delete from referral_code_reservations where id = p_reservation_id;
  end if;
end;
$$;

revoke execute on function increment_referral_code_usage(uuid, uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid, uuid) to service_role;
