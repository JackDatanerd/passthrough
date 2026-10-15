-- Database layer (Section 10), independent audit. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version this records).
--
-- 1. Verification tombstones are written INSIDE the transaction that makes them necessary.
--    deleteAccount / deleteScan / deleteScanHistory used to run the irreversible scrub or delete first and
--    write the tombstones as a separate, best-effort step afterwards (recordTombstones only logs a failure).
--    A failure between the two left every verification link already printed on a resume answering "not
--    found" instead of "removed by its owner", and a file's hash unrecognised. A BEFORE DELETE trigger on
--    scans and a loop at the top of scrub_account_data now do it atomically, for every delete path (user,
--    bulk, admin, SQL). The Worker's own recordTombstones calls stay (idempotent) — they also purge the
--    badge cache.
--
-- 2. scrub_account_data (the NINTH definition; 0075's body is the base, nothing it covered is dropped):
--      + tombstones first (above)
--      + email_logs rows addressed to the account's UNCONFIRMED pending_email are renamed like the main
--        address — the confirmation mail went to that address and the log row named it
--      - paystack_customer_code / paystack_auth_code (users) and payments.paystack_auth_code: the columns are
--        dropped (point 6), so nothing to scrub
--
-- 3. Retention for two tables that only ever grew:
--      user_sessions — a row holds the sign-in IP and user-agent. create_user_session only cleaned the rows of
--                      the user who was signing in, so a person who never came back kept theirs forever.
--      claude_usage  — the Claude cost ledger (0072), written on every call, read by nothing.
--    Both are bounded batch deletes the hourly cron calls (retention.service.js).
--
-- 4. Cost visibility: claude_usage_summary() / claude_usage_totals() back GET /api/admin/claude-usage.
--
-- 5. Indexes for queries that run regularly and had none:
--      scans (anon_expires_at) WHERE user_id IS NULL — the hourly anonymous-scan purge scanned the whole table
--      email_logs ("to")                              — the deletion scrub and the log purge filter on it
--      payments (referral_code_id)                    — the referral reconcile sweep
--      user_sessions (revoked_at) / (absolute_expires_at) — the new purge
--
-- 6. Dropped (nothing reads or writes them; the first three were payment credentials kept "just in case"):
--      users.paystack_customer_code, users.paystack_auth_code, payments.paystack_auth_code, scans.integrity_score
--    (its CHECK constraint goes with it). The function below is replaced BEFORE the columns go.

-- ── 1. tombstones ────────────────────────────────────────────────────────────

create or replace function write_verification_tombstone(
  p_code text, p_resume_hash text, p_pdf_hash text, p_history jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hashes text[] := array[p_resume_hash, p_pdf_hash];
  h        jsonb;
begin
  if p_code is null then
    return;
  end if;
  if p_history is not null and jsonb_typeof(p_history) = 'array' then
    for h in select * from jsonb_array_elements(p_history) loop
      if jsonb_typeof(h) = 'object' then
        v_hashes := v_hashes || array[h ->> 'docx', h ->> 'pdf'];
      end if;
    end loop;
  end if;
  insert into verification_tombstones (code) values (p_code) on conflict (code) do nothing;
  insert into verification_tombstone_hashes (hash, code)
  select distinct x, p_code from unnest(v_hashes) as x
   where x is not null and x ~ '^[0-9a-f]{64}$'
  on conflict (hash) do nothing;
end;
$$;

revoke execute on function write_verification_tombstone(text, text, text, jsonb) from public, anon, authenticated;
grant  execute on function write_verification_tombstone(text, text, text, jsonb) to service_role;

create or replace function scans_tombstone_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.verification_code is not null then
    perform write_verification_tombstone(old.verification_code, old.resume_hash, old.resume_pdf_hash, old.resume_hash_history);
  end if;
  return old;
end;
$$;

revoke execute on function scans_tombstone_on_delete() from public, anon, authenticated;

drop trigger if exists scans_tombstone_trg on scans;
create trigger scans_tombstone_trg
  before delete on scans
  for each row execute function scans_tombstone_on_delete();

-- ── 2. scrub_account_data ────────────────────────────────────────────────────

create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_email     text;
  v_pending_email text;
  v_placeholder   text := 'deleted-' || p_user_id || '@passthrough.dev';
  r               record;
begin
  select email, pending_email into v_old_email, v_pending_email from users where id = p_user_id;

  -- The page links and file fingerprints this account published outlive it as tombstones (0036 / 0049).
  -- Done FIRST, in this same transaction: the columns are nulled below, so a failure after that point can no
  -- longer be recovered from.
  for r in
    select verification_code, resume_hash, resume_pdf_hash, resume_hash_history
      from scans where user_id = p_user_id and verification_code is not null
  loop
    perform write_verification_tombstone(r.verification_code, r.resume_hash, r.resume_pdf_hash, r.resume_hash_history);
  end loop;

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
    user_edited_resume_data        = null,
    fix_ats_report                 = null,
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

  -- Homepage outcomes (0070): the story is personal text and the credential link points at a page this
  -- same function just disabled, so both go. The outcome ANSWER itself stays, anonymised.
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link, captured above before the users
  -- row below overwrites it. An unconfirmed pending address was mailed too (the confirmation link).
  if v_old_email is not null then
    update email_logs set "to" = v_placeholder where "to" = v_old_email;
  end if;
  if v_pending_email is not null and v_pending_email is distinct from v_old_email then
    update email_logs set "to" = v_placeholder where "to" = v_pending_email;
  end if;

  -- Auth sessions (0047) carry the sign-in IP and user-agent.
  delete from user_sessions where user_id = p_user_id;

  -- Additional saved profiles (0067) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

  update users set
    deleted_at              = now(),
    email                    = v_placeholder,
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    saved_profile_prev       = null,
    token_version            = token_version + 1,
    reset_token              = null,
    reset_token_expiry       = null,
    email_verify_token       = null,
    email_verify_expiry      = null,
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

-- CREATE OR REPLACE keeps the grants 0023 set; restated so this file reads on its own.
revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

-- ── 6. dead columns (after the function that named them is replaced) ─────────

alter table users    drop column if exists paystack_customer_code;
alter table users    drop column if exists paystack_auth_code;
alter table payments drop column if exists paystack_auth_code;
alter table scans    drop column if exists integrity_score;

-- ── 5. indexes ───────────────────────────────────────────────────────────────

create index if not exists idx_scans_anon_expires
  on scans (anon_expires_at) where user_id is null and anon_expires_at is not null;
create index if not exists idx_email_logs_to
  on email_logs ("to");
create index if not exists idx_payments_referral_code
  on payments (referral_code_id) where referral_code_id is not null;
create index if not exists idx_user_sessions_revoked_at
  on user_sessions (revoked_at) where revoked_at is not null;
create index if not exists idx_user_sessions_absolute_expires
  on user_sessions (absolute_expires_at);

-- ── 3. retention ─────────────────────────────────────────────────────────────

-- A session is dead once it was revoked, or passed its absolute expiry, p_days ago. 14 days is longer than any
-- token's lifetime, so no live token can still point at a row this removes. Bounded: the cron calls it every hour.
create or replace function purge_dead_sessions(p_days int default 14, p_batch int default 5000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  with d as (
    select id from user_sessions
     where revoked_at < now() - make_interval(days => greatest(p_days, 1))
        or absolute_expires_at < now() - make_interval(days => greatest(p_days, 1))
     limit greatest(p_batch, 1)
  )
  delete from user_sessions s using d where s.id = d.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function purge_old_claude_usage(p_days int default 400, p_batch int default 20000)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  with d as (
    select id from claude_usage
     where created_at < now() - make_interval(days => greatest(p_days, 1))
     limit greatest(p_batch, 1)
  )
  delete from claude_usage u using d where u.id = d.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ── 4. cost visibility ───────────────────────────────────────────────────────

create or replace function claude_usage_summary(p_days int default 30)
returns table (day date, label text, model text, calls bigint, input_tokens bigint, output_tokens bigint)
language sql
stable
security definer
set search_path = public
as $$
  select (u.created_at at time zone 'UTC')::date, u.label, u.model,
         count(*)::bigint, coalesce(sum(u.input_tokens), 0)::bigint, coalesce(sum(u.output_tokens), 0)::bigint
    from claude_usage u
   where u.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 400))
   group by 1, 2, 3
   order by 1 desc, 2, 3;
$$;

create or replace function claude_usage_totals(p_days int default 30)
returns table (calls bigint, input_tokens bigint, output_tokens bigint, scans bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint, coalesce(sum(u.input_tokens), 0)::bigint, coalesce(sum(u.output_tokens), 0)::bigint,
         count(distinct u.scan_id)::bigint
    from claude_usage u
   where u.created_at >= now() - make_interval(days => least(greatest(p_days, 1), 400));
$$;

revoke execute on function purge_dead_sessions(int, int)      from public, anon, authenticated;
revoke execute on function purge_old_claude_usage(int, int)   from public, anon, authenticated;
revoke execute on function claude_usage_summary(int)          from public, anon, authenticated;
revoke execute on function claude_usage_totals(int)           from public, anon, authenticated;
grant  execute on function purge_dead_sessions(int, int)      to service_role;
grant  execute on function purge_old_claude_usage(int, int)   to service_role;
grant  execute on function claude_usage_summary(int)          to service_role;
grant  execute on function claude_usage_totals(int)           to service_role;

-- ── 7. function privileges: the forward-looking default of 0023 did not do what it said ──────────────────────
-- 0023 ended with `alter default privileges IN SCHEMA public revoke execute on functions from public, anon,
-- authenticated`, promising that every future function would be un-callable by the client roles unless a
-- migration opted in. A schema-scoped default can only take back privileges a schema-scoped default granted
-- (Supabase's grants to anon / authenticated); the privilege every new function gets from Postgres itself —
-- EXECUTE for PUBLIC, which anon and authenticated both inherit — is a GLOBAL default and is untouched by it.
-- So a function whose migration forgot its own `revoke ... from public` stayed callable through
-- POST /rest/v1/rpc/<name> by anyone holding the anon key. Every RPC since 0023 revoked explicitly (which is
-- why nothing sensitive was ever exposed), but three helpers added later did not:
--   lead_mailbox_key(text)                (0076, pure function)
--   employer_leads_set_mailbox_key()      (0076, trigger function)
--   scrub_outcome_story_on_scan_delete()  (0074, trigger function)
-- None can read or change data when called directly, so this closes a hole that was open but empty — and makes
-- the promise true: the GLOBAL default (no IN SCHEMA) is now revoked for the role that runs the migrations.
-- tests/migrations.pglite.test.js (added in 0082 - it did not exist when this was written) applies every migration to a real Postgres and fails if any function in
-- `public` is executable by anon / authenticated / PUBLIC.
alter default privileges revoke execute on functions from public;

revoke execute on function lead_mailbox_key(text)                from public, anon, authenticated;
revoke execute on function employer_leads_set_mailbox_key()      from public, anon, authenticated;
revoke execute on function scrub_outcome_story_on_scan_delete()  from public, anon, authenticated;
grant  execute on function lead_mailbox_key(text)                to service_role;
grant  execute on function employer_leads_set_mailbox_key()      to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 77, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 77;   -- never move the version BACKWARDS (a re-run of an older file)
