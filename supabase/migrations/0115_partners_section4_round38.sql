-- Partners / referral, round 38.
--
-- 1. partner_terms_acceptances: an append-only trail of every acceptance of the partner terms (application, dashboard accept).
--    partners.terms_version only ever holds the LATEST one, so a version bump erased the proof of the earlier acceptance.
-- 2. commission_ledger.adjusts_ledger_id: a partial-refund adjustment points at the sale it reduces, so the cap (never take back more
--    than the sale earned) and a later full reversal can both be computed from the ledger itself.
-- 3. adjust_sale_commission(): records one such adjustment atomically under the sale's row lock.
-- Additive and idempotent. Service role only, like every other table here.

create table if not exists partner_terms_acceptances (
  id                uuid primary key default gen_random_uuid(),
  partner_id        uuid references partners(id) on delete set null,
  application_email text,
  version           text not null,
  source            text not null check (source in ('application', 'dashboard')),
  accepted_at       timestamptz not null default now(),
  ip_hash           text,
  user_agent        text,
  check (partner_id is not null or application_email is not null)
);
create index if not exists partner_terms_acceptances_partner_idx on partner_terms_acceptances (partner_id, accepted_at desc);
alter table partner_terms_acceptances enable row level security;

alter table commission_ledger add column if not exists adjusts_ledger_id uuid references commission_ledger(id) on delete restrict;
create index if not exists commission_ledger_adjusts_idx on commission_ledger (adjusts_ledger_id) where adjusts_ledger_id is not null;
alter table commission_ledger drop constraint if exists commission_ledger_adjusts_shape_check;
alter table commission_ledger add constraint commission_ledger_adjusts_shape_check check (adjusts_ledger_id is null or kind = 'ADJUSTMENT');

-- Returns jsonb { status, row, remaining_cents }. status is one of: ok, not_found, not_a_sale, already_reversed, exceeds.
-- p_amount_cents is the POSITIVE amount to take back from the partner.
create or replace function adjust_sale_commission(
  p_ledger_id    uuid,
  p_amount_cents int,
  p_reason       text,
  p_created_by   uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale      commission_ledger%rowtype;
  v_taken     bigint;
  v_remaining bigint;
  v_row       commission_ledger%rowtype;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'adjust_sale_commission: p_amount_cents must be positive' using errcode = '22023';
  end if;

  select * into v_sale from commission_ledger where id = p_ledger_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_sale.kind <> 'SALE' or v_sale.reverses_ledger_id is not null or v_sale.payment_id is null then
    return jsonb_build_object('status', 'not_a_sale');
  end if;
  if exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) then
    return jsonb_build_object('status', 'already_reversed');
  end if;

  select coalesce(sum(-commission_amount_cents), 0) into v_taken
    from commission_ledger where adjusts_ledger_id = p_ledger_id;
  v_remaining := v_sale.commission_amount_cents - v_taken;
  if p_amount_cents > v_remaining then
    return jsonb_build_object('status', 'exceeds', 'remaining_cents', greatest(v_remaining, 0));
  end if;

  insert into commission_ledger (partner_id, kind, gross_amount_cents, commission_rate, commission_amount_cents, currency,
                                 adjustment_reason, created_by, adjusts_ledger_id)
  values (v_sale.partner_id, 'ADJUSTMENT', 0, 0, -p_amount_cents, v_sale.currency, p_reason, p_created_by, p_ledger_id)
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'row', to_jsonb(v_row), 'remaining_cents', v_remaining - p_amount_cents);
end;
$$;
revoke execute on function adjust_sale_commission(uuid, int, text, uuid) from public, anon, authenticated;
grant  execute on function adjust_sale_commission(uuid, int, text, uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (115, '0115_partners_section4_round38')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 115, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 115;   -- never move the version BACKWARDS (a re-run of an older file)
