-- Partners / Referral program, section 4 round 20. Additive and idempotent.
--
-- 1. increment_referral_sub_clicks (0098) had no bound on how many DISTINCT channel tags one code could collect. The endpoint is
--    public and codes are public, so anyone could post random tags until a partner's tag table outgrew what the dashboard reads.
--    A code now keeps at most 50 distinct tags; an existing tag always keeps counting, a 51st new one is dropped. The count and
--    the insert are serialised per code with an advisory lock so two concurrent first-clicks cannot both squeeze past the cap.
-- 2. partners.status gains 'ENDED' (terms §7 promises that a membership can end; only PAUSED existed). Treated everywhere as
--    "not ACTIVE": no discount, no commission, no clicks. Not used in this file (an enum value added in a transaction cannot be
--    used until it commits).
-- 3. partners.tax_country / tax_id: optional tax details kept with the payout details (for withholding / tax-form requests).
--    Deliberately NOT part of payout_details, so adding them never trips the post-change payout hold.
-- 4. referral_signup_counts: the dashboard ran one COUNT per code; this answers for all of a partner's codes in one call.

-- ── 1. cap on channel tags per code ──────────────────────────────────────────
create or replace function increment_referral_sub_clicks(p_code text, p_sub text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_sub is null or p_sub !~ '^[a-z0-9_-]{1,32}$' then return; end if;

  select rc.id into v_id
    from referral_codes rc
   where rc.code = p_code
     and rc.active
     and (rc.expires_at is null or rc.expires_at > now())
     and exists (select 1 from partners p where p.id = rc.partner_id and p.status = 'ACTIVE');
  if v_id is null then return; end if;

  perform pg_advisory_xact_lock(hashtext('referral_sub_clicks:' || v_id::text));

  update referral_sub_clicks set clicks = clicks + 1 where code_id = v_id and sub = p_sub;
  if found then return; end if;

  if (select count(*) from referral_sub_clicks where code_id = v_id) < 50 then
    insert into referral_sub_clicks (code_id, sub, clicks) values (v_id, p_sub, 1);
  end if;
end;
$$;
revoke execute on function increment_referral_sub_clicks(text, text) from public, anon, authenticated;
grant  execute on function increment_referral_sub_clicks(text, text) to service_role;

-- ── 2. ENDED membership ──────────────────────────────────────────────────────
alter type partner_status_enum add value if not exists 'ENDED';

-- ── 3. tax details ───────────────────────────────────────────────────────────
alter table partners add column if not exists tax_country text;
alter table partners add column if not exists tax_id text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'partners_tax_country_check') then
    alter table partners add constraint partners_tax_country_check check (tax_country is null or tax_country ~ '^[A-Z]{2}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'partners_tax_id_check') then
    alter table partners add constraint partners_tax_id_check check (tax_id is null or char_length(tax_id) between 3 and 40);
  end if;
end $$;

-- ── 4. signup counts in one call ─────────────────────────────────────────────
create or replace function referral_signup_counts(p_codes text[], p_since timestamptz)
returns table (code text, signups int)
language sql
security definer
set search_path = public
as $$
  select u.referred_by_code, count(*)::int
    from users u
   where u.referred_by_code = any (p_codes)
     and u.referred_at >= p_since
   group by u.referred_by_code;
$$;
revoke execute on function referral_signup_counts(text[], timestamptz) from public, anon, authenticated;
grant  execute on function referral_signup_counts(text[], timestamptz) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (99, '0099_partners_section4_round20')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 99, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 99;   -- never move the version BACKWARDS (a re-run of an older file)
