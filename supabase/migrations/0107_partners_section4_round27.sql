-- Partners / Referral program, section 4, round 27.
--
--  1. partners.dashboard_token_version: dashboard links stop being stored. A link is now
--     "<partner id>.<HMAC(secret, id:version)>", re-derived whenever an email needs it, so a database or backup read
--     no longer yields working dashboard links. dashboard_token becomes nullable: partners created before this
--     migration keep their stored token until their link is next rotated (the Worker accepts both forms).
--  2. payments.referral_commission_rate: the partner's rate is now stamped at checkout, so a rate change or a late
--     reconcile retry pays the rate the buyer's sale was made under.
--  3. reattribute_sale(): move one UNPAID, un-reversed sale to another partner's code in a single transaction
--     (ledger row, payment row and both codes' usage counters together).

alter table partners add column if not exists dashboard_token_version int not null default 0;
alter table partners alter column dashboard_token drop not null;

alter table payments add column if not exists referral_commission_rate numeric(5,4);

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
  v_row  commission_ledger%rowtype;
  v_code text;
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

  select code into v_code from referral_codes where id = p_to_code_id and partner_id = p_to_partner_id for update;
  if v_code is null then return 'target_not_found'; end if;

  if v_row.usage_counted then
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
insert into applied_migrations (version, name) values (107, '0107_partners_section4_round27')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 107, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 107;   -- never move the version BACKWARDS (a re-run of an older file)
