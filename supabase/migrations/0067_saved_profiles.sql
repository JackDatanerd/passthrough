-- Profile & Dashboard (Section 6), multiple saved profiles. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code.
--
-- One saved profile per account meant anyone job-hunting across two tracks had to overwrite and
-- re-save every time. users.saved_profile stays the PRIMARY profile (every existing reader keeps
-- working untouched); this table holds up to 4 ADDITIONAL, labelled ones.

create table if not exists saved_profiles (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  label          text not null,
  resume_data    jsonb not null,
  role_category  text,
  source_scan_id uuid,
  saved_at       timestamptz not null default now(),
  edited_at      timestamptz
);
create index if not exists idx_saved_profiles_user on saved_profiles (user_id, saved_at);
alter table saved_profiles enable row level security;

-- add_saved_profile: the cap is enforced under a per-user advisory lock so two tabs saving at
-- once cannot both slip past it. Returns the new id, or null when the account is already full.
create or replace function add_saved_profile(p_user_id uuid, p_label text, p_resume jsonb, p_role_category text, p_source_scan_id uuid, p_max int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('saved_profiles:' || p_user_id::text));
  if (select count(*) from saved_profiles where user_id = p_user_id) >= p_max then
    return null;
  end if;
  insert into saved_profiles (user_id, label, resume_data, role_category, source_scan_id)
  values (p_user_id, p_label, p_resume, p_role_category, p_source_scan_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- update_saved_profile: replaces the resume (and optionally the label) of ONE extra profile.
-- p_expected_version is the edited_at-or-saved_at value the editor loaded; when it no longer
-- matches (a second tab saved meanwhile) nothing is written and 'conflict' comes back.
create or replace function update_saved_profile(p_user_id uuid, p_id uuid, p_resume jsonb, p_label text, p_expected_version timestamptz, p_edited_at timestamptz)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update saved_profiles
     set resume_data = p_resume,
         label       = coalesce(p_label, label),
         edited_at   = p_edited_at
   where id = p_id and user_id = p_user_id
     and (p_expected_version is null or coalesce(edited_at, saved_at) = p_expected_version);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'ok'; end if;
  if exists (select 1 from saved_profiles where id = p_id and user_id = p_user_id) then return 'conflict'; end if;
  return 'missing';
end;
$$;

-- clear_saved_profile_source now also clears the pointer on the additional profiles.
create or replace function clear_saved_profile_source(p_user_id uuid, p_scan_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update users
     set saved_profile = jsonb_set(saved_profile, '{sourceScanId}', 'null'::jsonb)
   where id = p_user_id
     and saved_profile is not null
     and saved_profile ->> 'sourceScanId' = any (select x::text from unnest(p_scan_ids) as x);
  update saved_profiles set source_scan_id = null
   where user_id = p_user_id and source_scan_id = any (p_scan_ids);
end;
$$;

revoke execute on function add_saved_profile(uuid, text, jsonb, text, uuid, int) from public, anon, authenticated;
grant  execute on function add_saved_profile(uuid, text, jsonb, text, uuid, int) to service_role;
revoke execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) to service_role;
revoke execute on function clear_saved_profile_source(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function clear_saved_profile_source(uuid, uuid[]) to service_role;

-- scrub_account_data: identical to 0061 plus the saved_profiles delete.
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

  -- Additional saved profiles (0067) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

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

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 67, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
