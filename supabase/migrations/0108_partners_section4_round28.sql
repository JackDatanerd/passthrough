-- 0108: Section 4 round 28.
--
--  1. increment_referral_code_usage(): the code whose counter is bumped is now read from the LOCKED ledger row, not trusted from
--     the caller. recordConversion passes the code id it resolved BEFORE writing the ledger row; an admin moving the sale to
--     another partner's code (reattribute_sale, 0107) in the milliseconds between that insert and this bump left the sale on the
--     new code while the use was charged to the old one. p_code_id is still the fallback for a call with no ledger id.
--  2. reattribute_sale(): refuses ('target_exhausted') a move that would push the TARGET code past its usage limit. The sale's
--     slot only moves when it was actually counted, so only then can the move overdraw the target.
--
-- Both are `create or replace` with unchanged signatures, so a re-run is harmless.

create or replace function increment_referral_code_usage(
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
  v_flipped  int := 1;
  v_reversed boolean := false;
  v_code_id  uuid := p_code_id;
  v_ledger_code uuid;
begin
  if p_ledger_id is not null then
    select referral_code_id into v_ledger_code from commission_ledger where id = p_ledger_id for update;
    if v_ledger_code is not null then v_code_id := v_ledger_code; end if;   -- the sale's CURRENT code, even if it was moved
    select exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) into v_reversed;

    update commission_ledger
       set usage_counted = true
     where id = p_ledger_id and usage_counted = false;
    get diagnostics v_flipped = row_count;

    if v_reversed then v_flipped := 0; end if;   -- settled, but the refunded sale never consumes a slot
  end if;

  if v_flipped > 0 then
    update referral_codes set uses_so_far = uses_so_far + 1 where id = v_code_id;
  end if;

  if p_reservation_id is not null then
    delete from referral_code_reservations where id = p_reservation_id;
  end if;

  return v_flipped > 0;
end;
$$;

revoke execute on function increment_referral_code_usage(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid, uuid, uuid) to service_role;

create or replace function reattribute_sale(
  p_ledger_id        uuid,
  p_to_code_id       uuid,
  p_to_partner_id    uuid,
  p_rate             numeric,
  p_commission_cents int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   commission_ledger%rowtype;
  v_code  text;
  v_limit int;
  v_uses  int;
begin
  select * into v_row from commission_ledger where id = p_ledger_id for update;
  if not found then return 'not_found'; end if;
  if v_row.kind <> 'SALE' or v_row.reverses_ledger_id is not null or v_row.payment_id is null then
    return 'not_a_sale';
  end if;
  if v_row.payout_id is not null then return 'already_paid'; end if;
  if exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) then
    return 'already_reversed';
  end if;
  if v_row.referral_code_id = p_to_code_id then return 'same_code'; end if;

  select code, usage_limit, uses_so_far into v_code, v_limit, v_uses
    from referral_codes where id = p_to_code_id and partner_id = p_to_partner_id for update;
  if v_code is null then return 'target_not_found'; end if;

  if v_row.usage_counted then
    if v_limit is not null and v_uses >= v_limit then return 'target_exhausted'; end if;
    update referral_codes set uses_so_far = greatest(uses_so_far - 1, 0) where id = v_row.referral_code_id;
    update referral_codes set uses_so_far = uses_so_far + 1 where id = p_to_code_id;
  end if;

  update commission_ledger
     set partner_id = p_to_partner_id,
         referral_code_id = p_to_code_id,
         commission_rate = p_rate,
         commission_amount_cents = p_commission_cents,
         attribution_sub = null
   where id = p_ledger_id;

  update payments
     set referral_code_id = p_to_code_id,
         referral_code = v_code,
         referral_sub = null,
         referral_commission_rate = p_rate
   where id = v_row.payment_id;

  return 'ok';
end;
$$;

revoke execute on function reattribute_sale(uuid, uuid, uuid, numeric, int) from public, anon, authenticated;
grant  execute on function reattribute_sale(uuid, uuid, uuid, numeric, int) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (108, '0108_partners_section4_round28')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 108, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 108;   -- never move the version BACKWARDS (a re-run of an older file)
