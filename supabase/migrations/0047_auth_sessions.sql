-- Auth section round 1 (feature gaps G2 + B3/B4 + email-change replay).
--
-- 1. user_sessions — real, server-side sessions. Until now a JWT was the whole
--    session: "sign out" only deleted the client's copy, a copied token stayed
--    valid for its full 7 days, and getMe() re-issued a fresh token whenever
--    fewer than 24h were left, so a stolen token that pinged /auth/me daily
--    never expired. Each token now carries a `sid` that points at a row here;
--    the row can be revoked (logout, per-device revoke, sign-out-everywhere)
--    and has an ABSOLUTE expiry that silent renewal can never extend.
--    token_version stays as the blunt "revoke everything" switch (password
--    change/reset, account delete), and tokens issued before this migration
--    (no sid) keep working until they expire or are upgraded by getMe().
--
-- 2. create_user_session / revoke_other_sessions — SQL functions so the
--    bookkeeping is atomic and the table cannot grow without bound (stale rows
--    are purged and the number of live sessions per user is capped on every
--    sign-in; no cron needed). revoke_other_sessions bumps token_version with
--    a single `token_version + 1` UPDATE — the old read-then-write in the
--    controller could lose an update under concurrency and LOWER the version,
--    quietly reviving tokens that had been revoked.
--
-- 3. users.email_change_done_token — sha256 of the last email-change token
--    that was successfully consumed, so opening the same confirmation link a
--    second time (mail scanners, double taps, a back-button) can be answered
--    "already confirmed" instead of "invalid or expired". Same idea as the
--    replay handling on email verification. It carries no capability: the
--    token is already spent.
--
-- Idempotent: safe to re-run.

create table if not exists user_sessions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  absolute_expires_at  timestamptz not null,
  revoked_at           timestamptz,
  ip                   text,
  user_agent           text
);

create index if not exists user_sessions_user_id_idx on user_sessions (user_id);

-- Same reasoning as 0014_enable_rls.sql: no policies, so anon/authenticated get
-- nothing over PostgREST; the Worker's service_role key bypasses RLS.
alter table user_sessions enable row level security;

alter table users add column if not exists email_change_done_token text;

create or replace function create_user_session(
  p_user_id       uuid,
  p_ip            text,
  p_user_agent    text,
  p_lifetime_days int,
  p_max_active    int default 20
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
  -- Housekeeping: rows that have been dead for a week are of no use to anyone.
  delete from user_sessions s
   where s.user_id = p_user_id
     and (s.revoked_at < now() - interval '7 days'
          or s.absolute_expires_at < now() - interval '7 days');

  insert into user_sessions (user_id, absolute_expires_at, ip, user_agent)
  values (p_user_id, v_abs, p_ip, p_user_agent)
  returning user_sessions.id into v_id;

  -- Cap live sessions per user: revoke the least-recently-used surplus.
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

create or replace function revoke_other_sessions(p_user_id uuid, p_keep_session uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version int;
begin
  update users set token_version = token_version + 1
   where id = p_user_id and deleted_at is null
   returning token_version into v_version;

  if v_version is null then
    return null;
  end if;

  update user_sessions set revoked_at = now()
   where user_id = p_user_id
     and revoked_at is null
     and (p_keep_session is null or id <> p_keep_session);

  return v_version;
end;
$$;

-- Both are called only by the Worker (service_role) — see 0023 for why every
-- new function must be locked down explicitly.
revoke execute on function create_user_session(uuid, text, text, int, int) from public, anon, authenticated;
grant  execute on function create_user_session(uuid, text, text, int, int) to service_role;

revoke execute on function revoke_other_sessions(uuid, uuid) from public, anon, authenticated;
grant  execute on function revoke_other_sessions(uuid, uuid) to service_role;

-- scrub_account_data: identical to 0040's, plus (a) delete the account's
-- user_sessions rows (they hold IP + user-agent) and (b) clear the
-- email_change_done_token marker. `create or replace` keeps the EXECUTE grants
-- 0023 set on it.
create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_email text;
begin
  select email into v_old_email from users where id = p_user_id;

  update scans set
    resume_path                  = null,
    resume_ats_path               = null,
    resume_pdf_path                = null,
    resume_original_name           = null,
    resume_hash                    = null,
    resume_pdf_hash                = null,
    resume_hash_history            = '[]'::jsonb,
    job_description_text           = null,
    job_description_url            = null,
    job_title                      = null,
    candidate_first_name           = null,
    cover_letter_text              = null,
    raw_brain_dump_text            = null,
    original_resume_data           = null,
    rewritten_resume_data          = null,
    quantification_prompts         = null,
    full_ats_report                = null,
    verification_code              = null,
    verification_url               = null,
    verify_expose_docx             = false,
    verify_expose_pdf              = false,
    verify_hide_name                = false,
    verification_status             = 'ACTIVE',
    verification_revoked_at         = null,
    verification_revoked_reason     = null,
    fix_payment_id                  = null,
    contact_name                    = null,
    contact_email                   = null
  where user_id = p_user_id;

  update payments set
    paystack_auth_code = null
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link,
  -- captured above before the users row below overwrites it.
  if v_old_email is not null then
    update email_logs set "to" = 'deleted-' || p_user_id || '@passthrough.dev'
    where "to" = v_old_email;
  end if;

  -- Auth sessions (0047) carry the sign-in IP and user-agent, so they are
  -- personal data: remove them with the account rather than leave them
  -- attached to a soft-deleted users row.
  delete from user_sessions where user_id = p_user_id;

  update users set
    deleted_at              = now(),
    email                    = 'deleted-' || p_user_id || '@passthrough.dev',
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    token_version            = token_version + 1,
    reset_token              = null,
    reset_token_expiry       = null,
    email_verify_token       = null,
    email_verify_expiry      = null,
    paystack_customer_code   = null,
    paystack_auth_code       = null,
    pending_email            = null,
    pending_email_token      = null,
    pending_email_expiry     = null,
    last_login_at            = null,
    last_login_ip            = null,
    previous_login_at        = null,
    previous_login_ip        = null,
    last_login_alert_at      = null,
    email_change_done_token  = null
  where id = p_user_id;
end;
$$;
