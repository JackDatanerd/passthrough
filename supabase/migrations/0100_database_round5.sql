-- Database layer, round 5. Additive and idempotent (every statement is create-or-replace / if-not-exists / guarded).
-- Found by running every migration on a real Postgres 16 with Supabase's roles and hammering the functions from many
-- concurrent connections (PGlite is single-connection, so none of this could be seen there).
--
-- 1. create_user_session capped live sessions per user with an insert-then-trim that concurrent logins could not see each
--    other's rows in: 15 simultaneous logins left 10 live sessions against a cap of 3 (until the next login). It now takes the
--    same per-user advisory lock add_saved_profile / promote_saved_profile already use.
-- 2. increment_referral_sub_clicks (0099) stopped recording NEW channel tags once a code held 50, and the endpoint is public and
--    codes are public: 50 junk tags permanently shut a partner's real channels out. A new tag now evicts the least-clicked tag
--    that has no attributed signup or sale (those are real and never evicted); only if every tag is attributed is it dropped.
-- 3. referral_tier_prices_valid accepted up to 10 digits (9,999,999,999) but payments.amount_cents is a 4-byte integer
--    (2,147,483,647): a mistyped price passed every check and then failed every checkout with "integer out of range".
-- 4. release_referral_code_usage_for_ledger was not idempotent (it decremented uses_so_far on every call) and its only caller is
--    best-effort, so it could never be safely retried and a transient failure leaked a usage slot for good. A release now stamps
--    commission_ledger.usage_released_at and is a no-op the second time; a settle that finds the sale already reversed stamps it
--    too (that sale never held a slot), so a retry cannot over-decrement. Existing reversed sales are backfilled.
-- 4b. referral_usage_drift(): compares every code's uses_so_far with what the ledger says it should be, so a leak is visible
--    (the health check reports it).
-- 5. prompt_outcome_rates (0094) was a plain view: views run with their owner's rights and so bypass RLS on scans and
--    scan_outcomes; it is only safe because of its grants. It is now security_invoker (Supabase's Security Advisor flags the
--    plain form), and letter_prompt_outcome_rates is the same read for the cover-letter prompt generation, which was stamped
--    (letter_prompt_version) but never analysable.
-- 6. set_updated_at / employer_leads_set_mailbox_key / lead_mailbox_key did not pin search_path (Supabase linter:
--    function_search_path_mutable).
-- 7. grant_upgrade_credit_once consumed the once-only marker before checking that the user exists (its sibling
--    grant_fix_credit_once checks first), so a missing user lost the credit for good.

-- ── 1. session cap under concurrency ─────────────────────────────────────────

create or replace function create_user_session(
  p_user_id uuid, p_ip text, p_user_agent text, p_lifetime_days int, p_max_active int default 20
)
returns table (session_id uuid, session_expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id  uuid;
  v_abs timestamptz := now() + make_interval(days => p_lifetime_days);
begin
  -- One login at a time per user: without it, concurrent callers each trim against a snapshot that lacks the others' new rows.
  perform pg_advisory_xact_lock(hashtext('user_sessions:' || p_user_id::text));

  delete from user_sessions s
   where s.user_id = p_user_id
     and (s.revoked_at < now() - interval '7 days'
          or s.absolute_expires_at < now() - interval '7 days');

  insert into user_sessions (user_id, absolute_expires_at, ip, user_agent)
  values (p_user_id, v_abs, p_ip, p_user_agent)
  returning user_sessions.id into v_id;

  update user_sessions s set revoked_at = now()
   where s.user_id = p_user_id
     and s.revoked_at is null
     and s.id in (
       select o.id from user_sessions o
        where o.user_id = p_user_id
          and o.revoked_at is null
          and o.absolute_expires_at > now()
        order by o.last_seen_at desc
        offset p_max_active
     );

  return query select v_id, v_abs;
end;
$$;
revoke execute on function create_user_session(uuid, text, text, int, int) from public, anon, authenticated;
grant  execute on function create_user_session(uuid, text, text, int, int) to service_role;

-- ── 2. channel tags: evict junk instead of locking real channels out ─────────

create or replace function increment_referral_sub_clicks(p_code text, p_sub text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    uuid;
  v_evict text;
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

  if (select count(*) from referral_sub_clicks where code_id = v_id) >= 50 then
    -- Full. A tag that produced a signup or a sale is a real channel: never evicted. Of the rest, the quietest goes.
    select t.sub into v_evict
      from referral_sub_clicks t
     where t.code_id = v_id
       and not exists (select 1 from payments p where p.referral_code_id = v_id and p.referral_sub = t.sub)
       and not exists (select 1 from users u, referral_codes rc
                        where rc.id = v_id and u.referred_by_code = rc.code and u.referred_sub = t.sub)
     order by t.clicks asc, t.sub asc
     limit 1;
    if v_evict is null then return; end if;      -- every tag is attributed: nothing safe to displace
    delete from referral_sub_clicks where code_id = v_id and sub = v_evict;
  end if;

  insert into referral_sub_clicks (code_id, sub, clicks) values (v_id, p_sub, 1);
end;
$$;
revoke execute on function increment_referral_sub_clicks(text, text) from public, anon, authenticated;
grant  execute on function increment_referral_sub_clicks(text, text) to service_role;

-- ── 3. tier prices must fit the payments column ──────────────────────────────

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
           or case when (e.value #>> '{}') ~ '^[1-9][0-9]{0,9}$' then (e.value #>> '{}')::numeric > 2147483647 else true end
     );
$$;

-- ── 4. usage release: idempotent, and visible when it drifts ─────────────────

alter table commission_ledger add column if not exists usage_released_at timestamptz;

-- A sale that was reversed after it was counted already gave its slot back (the old release ran once): mark it so a retry is a no-op.
update commission_ledger o
   set usage_released_at = r.created_at
  from commission_ledger r
 where r.reverses_ledger_id = o.id
   and o.usage_counted
   and o.usage_released_at is null;

create or replace function release_referral_code_usage_for_ledger(p_ledger_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code uuid;
begin
  update commission_ledger
     set usage_released_at = now()
   where id = p_ledger_id
     and referral_code_id is not null
     and usage_counted is true
     and usage_released_at is null
  returning referral_code_id into v_code;
  if not found then
    return false;
  end if;
  update referral_codes set uses_so_far = greatest(uses_so_far - 1, 0) where id = v_code;
  return true;
end;
$$;
revoke execute on function release_referral_code_usage_for_ledger(uuid) from public, anon, authenticated;
grant  execute on function release_referral_code_usage_for_ledger(uuid) to service_role;

create or replace function increment_referral_code_usage(p_code_id uuid, p_reservation_id uuid default null, p_ledger_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flipped  int := 1;
  v_reversed boolean := false;
begin
  if p_ledger_id is not null then
    perform 1 from commission_ledger where id = p_ledger_id for update;
    select exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) into v_reversed;

    update commission_ledger
       set usage_counted = true,
           -- settled but refunded: it never holds a slot, so a later release must not give one back
           usage_released_at = case when v_reversed then coalesce(usage_released_at, now()) else usage_released_at end
     where id = p_ledger_id and usage_counted = false;
    get diagnostics v_flipped = row_count;

    if v_reversed then v_flipped := 0; end if;
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

-- What uses_so_far SHOULD be: original sales that hold a slot (counted, not given back). Codes where the two differ.
create or replace function referral_usage_drift()
returns table (code_id uuid, code text, uses_so_far int, expected int)
language sql
stable
security definer
set search_path = public
as $$
  select rc.id, rc.code, rc.uses_so_far, x.n
    from referral_codes rc
    cross join lateral (
      select count(*)::int as n
        from commission_ledger l
       where l.referral_code_id = rc.id
         and l.kind = 'SALE'
         and l.reverses_ledger_id is null
         and l.usage_counted
         and l.usage_released_at is null) x
   where rc.uses_so_far <> x.n
   order by abs(rc.uses_so_far - x.n) desc, rc.code
   limit 50;
$$;
revoke execute on function referral_usage_drift() from public, anon, authenticated;
grant  execute on function referral_usage_drift() to service_role;

-- ── 5. views: invoker rights, and the letter prompt generation ───────────────

alter view prompt_outcome_rates set (security_invoker = true);

create or replace view letter_prompt_outcome_rates as
select s.letter_prompt_version as prompt_version,
       count(*)                                                   as responses,
       count(*) filter (where o.outcome = 'INTERVIEW')            as interviews,
       round(100.0 * count(*) filter (where o.outcome = 'INTERVIEW')
             / nullif(count(*) filter (where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')), 0), 1) as interview_pct
  from scan_outcomes o
  join scans s on s.id = o.scan_id
 where o.outcome in ('INTERVIEW', 'NO_INTERVIEW')
 group by s.letter_prompt_version;
alter view letter_prompt_outcome_rates set (security_invoker = true);
revoke all on letter_prompt_outcome_rates from anon, authenticated;
revoke all on prompt_outcome_rates        from anon, authenticated;

-- ── 6. pin search_path on the three that did not ─────────────────────────────

alter function set_updated_at()                  set search_path = public;
alter function employer_leads_set_mailbox_key()  set search_path = public;
alter function lead_mailbox_key(text)            set search_path = public;

-- ── 7. upgrade credit: check the user before spending the marker ─────────────

create or replace function grant_upgrade_credit_once(p_scan_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_user_id is null or not exists (select 1 from users where id = p_user_id) then
    return false;
  end if;
  update scans
     set upgrade_credit_granted_at = now()
   where id = p_scan_id
     and upgrade_credit_granted_at is null;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;
  update users set free_fix_credits = free_fix_credits + 1 where id = p_user_id;
  return true;
end;
$$;
revoke execute on function grant_upgrade_credit_once(uuid, uuid) from public, anon, authenticated;
grant  execute on function grant_upgrade_credit_once(uuid, uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (100, '0100_database_round5')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 100, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 100;   -- never move the version BACKWARDS (a re-run of an older file)
