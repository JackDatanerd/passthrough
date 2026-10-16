-- Database layer, round 4: defence in depth at the schema level, and three dead objects.
--
-- Every value below is already guarded in application code (atomic RPCs, zod). These constraints make the DATABASE refuse what the
-- app never sends, so a manual SQL fix, a future code path or a bad import cannot quietly put the books out of shape.
--
-- 1. Counters that must never go below zero: users.free_fix_credits, referral_codes.usage_limit / uses_so_far / clicks,
--    scans.fix_retry_count, employer_leads.submission_count. (commission_ledger.gross_amount_cents and
--    payouts.settled_commission_cents are deliberately NOT here: a reversal row stores the original sale NEGATED.)
--    Any existing violator is clamped to 0 first, so the migration cannot fail on production data.
-- 2. referral_codes.tier_prices must be a JSON object whose keys are the three real tiers (the payments.fix_tier set) and whose
--    values are positive whole numbers of minor units. A negative or text price used to be storable.
-- 3. admin_audit_log: the "append-only" trigger let ANY update that only set actor_id to NULL through (erasing who did it), and
--    row triggers do not fire on TRUNCATE. The NULL is now allowed only when the actor really no longer exists (the foreign
--    key's ON DELETE SET NULL), and TRUNCATE is refused.
-- 4. partners.payout_details_token has been written NULL since 0087 (the token lives hashed in payout_token_hash). The column
--    stays for old rows and old callers, but can no longer hold a clear-text secret again.
-- 5. Dead objects: decrement_referral_code_usage() (superseded by the inline greatest(...) in 0071, no caller), and two indexes
--    that another index already serves — idx_scans_user_id (leading column of idx_scans_user_display_score) and
--    payment_refunds_payment_idx (leading column of the (payment_id, event_key) unique key). They only cost writes.

-- ── 1. non-negative counters ─────────────────────────────────────────────────

update users            set free_fix_credits = 0 where free_fix_credits < 0;
update referral_codes   set usage_limit      = 0 where usage_limit      < 0;
update referral_codes   set uses_so_far      = 0 where uses_so_far      < 0;
update referral_codes   set clicks           = 0 where clicks           < 0;
update scans            set fix_retry_count  = 0 where fix_retry_count  < 0;
update employer_leads   set submission_count = 0 where submission_count < 0;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('users',           'users_free_fix_credits_nonneg_chk',   'free_fix_credits >= 0'),
      ('referral_codes',  'referral_codes_usage_limit_chk',      'usage_limit is null or usage_limit >= 0'),
      ('referral_codes',  'referral_codes_uses_so_far_chk',      'uses_so_far >= 0'),
      ('referral_codes',  'referral_codes_clicks_chk',           'clicks >= 0'),
      ('scans',           'scans_fix_retry_count_chk',           'fix_retry_count >= 0'),
      ('employer_leads',  'employer_leads_submission_count_chk', 'submission_count >= 0')
    ) as v(tbl, name, def)
  loop
    if not exists (select 1 from pg_constraint where conname = r.name) then
      execute format('alter table %I add constraint %I check (%s)', r.tbl, r.name, r.def);
    end if;
  end loop;
end $$;

-- ── 2. tier_prices shape ─────────────────────────────────────────────────────

create or replace function referral_tier_prices_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p is not null
     and jsonb_typeof(p) = 'object'
     and p <> '{}'::jsonb
     and not exists (
       select 1 from jsonb_each(p) e
        where e.key not in ('FIX', 'BADGE', 'FIX_PLAIN')
           or jsonb_typeof(e.value) <> 'number'
           or (e.value #>> '{}') !~ '^[1-9][0-9]{0,9}$'
     );
$$;

revoke execute on function referral_tier_prices_valid(jsonb) from public, anon, authenticated;
grant  execute on function referral_tier_prices_valid(jsonb) to service_role;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'referral_codes_tier_prices_chk') then
    -- Existing rows that already break the rule (none are written by the app) must not abort a deploy: the constraint is then added
    -- NOT VALID — every NEW insert/update is checked, the old rows are left for you to fix, then run
    --   alter table referral_codes validate constraint referral_codes_tier_prices_chk;
    if exists (select 1 from referral_codes where not referral_tier_prices_valid(tier_prices)) then
      raise notice 'referral_codes holds tier_prices outside {FIX,BADGE,FIX_PLAIN} -> positive whole minor units; constraint added NOT VALID. Find them: select id, code, tier_prices from referral_codes where not referral_tier_prices_valid(tier_prices)';
      alter table referral_codes add constraint referral_codes_tier_prices_chk check (referral_tier_prices_valid(tier_prices)) not valid;
    else
      alter table referral_codes add constraint referral_codes_tier_prices_chk check (referral_tier_prices_valid(tier_prices));
    end if;
  end if;
end $$;

-- ── 3. admin_audit_log: closer to append-only ────────────────────────────────

create or replace function admin_audit_log_append_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The only legitimate change: the actor's account was deleted and the foreign key's ON DELETE SET NULL blanks actor_id.
  -- By then the users row is gone, so "the actor still exists" means somebody is erasing attribution by hand.
  if tg_op = 'UPDATE' and new.actor_id is null and old.actor_id is not null
     and not exists (select 1 from users where id = old.actor_id)
     and (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  raise exception 'admin_audit_log is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;

revoke execute on function admin_audit_log_append_only() from public, anon, authenticated;

create or replace function admin_audit_log_no_truncate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'admin_audit_log is append-only (TRUNCATE refused)' using errcode = '42501';
end;
$$;

revoke execute on function admin_audit_log_no_truncate() from public, anon, authenticated;

drop trigger if exists admin_audit_log_no_truncate_trg on admin_audit_log;
create trigger admin_audit_log_no_truncate_trg
  before truncate on admin_audit_log
  for each statement execute function admin_audit_log_no_truncate();

-- ── 4. no clear-text payout token, ever again ────────────────────────────────

update partners set payout_details_token = null where payout_details_token is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'partners_payout_token_not_clear_chk') then
    alter table partners add constraint partners_payout_token_not_clear_chk check (payout_details_token is null);
  end if;
end $$;

-- ── 5. dead objects ──────────────────────────────────────────────────────────

drop function if exists decrement_referral_code_usage(uuid);
drop index if exists idx_scans_user_id;
drop index if exists payment_refunds_payment_idx;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (91, '0091_database_round4')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 91, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 91;   -- never move the version BACKWARDS (a re-run of an older file)
