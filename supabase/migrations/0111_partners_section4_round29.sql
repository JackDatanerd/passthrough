-- Partners / Referral program, section 4 round 29 (migration 0111). Additive and idempotent.
--
-- This file was first shipped as 0110, which collided with 0110_webhooks_round27.sql. A database that ran it under that number holds
-- the ledger row (110, '0110_partners_section4_round29') and never recorded the webhooks migration. The repair below puts the ledger
-- right, but ONLY when the webhooks trigger really exists (apply 0110_webhooks_round27.sql first); otherwise the row is left alone so
-- the health check keeps reporting 0110 as the one to run.
--
-- record_payout_settlement now re-checks the partner's payout_details_submitted_at UNDER the partner row lock. The Worker reads the
-- partner (and snapshots the account the money goes to) before calling this function; a details change landing in between used to
-- be recorded against the OLD snapshot. With p_check_details true, a mismatch returns { details_changed: true } and records nothing.
-- Old callers (five arguments) keep working: both new parameters default to "do not check".

drop function if exists record_payout_settlement(uuid, uuid[], jsonb, boolean, boolean);

create or replace function record_payout_settlement(
  p_partner_id        uuid,
  p_ledger_ids        uuid[],
  p_payout            jsonb,
  p_discard_if_empty  boolean default false,
  p_amount_is_auto    boolean default false,
  p_check_details     boolean default false,
  p_expected_details_submitted_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id            uuid := gen_random_uuid();
  v_requested     int  := coalesce(cardinality(p_ledger_ids), 0);
  v_claimed       int  := 0;
  v_claimed_cents bigint := 0;
  v_row           payouts%rowtype;
  v_submitted     timestamptz;
begin
  if p_payout is null or jsonb_typeof(p_payout) <> 'object' then
    raise exception 'record_payout_settlement: p_payout must be a JSON object' using errcode = '22023';
  end if;

  -- Serialises every payout recording / void for ONE partner.
  select payout_details_submitted_at into v_submitted from partners where id = p_partner_id for update;
  if not found then
    raise exception 'record_payout_settlement: partner % not found', p_partner_id using errcode = 'P0002';
  end if;

  if p_check_details and v_submitted is distinct from p_expected_details_submitted_at then
    return jsonb_build_object('payout', null, 'requested', v_requested, 'claimed', 0, 'claimed_cents', 0,
                              'discarded', false, 'details_changed', true);
  end if;

  insert into payouts (id, partner_id, amount_cents, currency, payout_method, payout_details_snapshot,
                       settled_commission_cents, note, internal_note, period_start, period_end)
  values (v_id, p_partner_id,
          (p_payout ->> 'amount_cents')::int,
          coalesce(p_payout ->> 'currency', 'USD'),
          (p_payout ->> 'payout_method')::payout_method_enum,
          coalesce(p_payout -> 'payout_details_snapshot', '{}'::jsonb),
          (p_payout ->> 'settled_commission_cents')::int,
          p_payout ->> 'note',
          p_payout ->> 'internal_note',
          (p_payout ->> 'period_start')::date,
          (p_payout ->> 'period_end')::date);

  if v_requested > 0 then
    with won as (
      update commission_ledger
         set payout_id = v_id
       where id = any (p_ledger_ids)
         and partner_id = p_partner_id
         and payout_id is null
      returning commission_amount_cents)
    select count(*)::int, coalesce(sum(commission_amount_cents), 0) into v_claimed, v_claimed_cents from won;

    if v_claimed < v_requested then
      if p_discard_if_empty and v_claimed = 0 then
        delete from payouts where id = v_id;
        return jsonb_build_object('payout', null, 'requested', v_requested, 'claimed', 0, 'claimed_cents', 0, 'discarded', true);
      end if;
      update payouts
         set settled_commission_cents = v_claimed_cents,
             amount_cents = case when p_amount_is_auto and v_claimed_cents >= 0 then v_claimed_cents else amount_cents end
       where id = v_id;
    end if;
  end if;

  select * into v_row from payouts where id = v_id;
  return jsonb_build_object('payout', to_jsonb(v_row), 'requested', v_requested, 'claimed', v_claimed,
                            'claimed_cents', v_claimed_cents, 'discarded', false);
end;
$$;

revoke execute on function record_payout_settlement(uuid, uuid[], jsonb, boolean, boolean, boolean, timestamptz) from public, anon, authenticated;
grant  execute on function record_payout_settlement(uuid, uuid[], jsonb, boolean, boolean, boolean, timestamptz) to service_role;

-- Ledger repair for a database that recorded this file as 110 (see the header). Only when the webhooks migration's trigger exists.
update applied_migrations set name = '0110_webhooks_round27'
 where version = 110 and name = '0110_partners_section4_round29'
   and exists (select 1 from pg_trigger where tgname = 'scans_stamp_fix_delivered');

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (111, '0111_partners_section4_round29')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 111, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 111;   -- never move the version BACKWARDS (a re-run of an older file)
