-- Profile & Dashboard (Section 6), audit round 10. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code: the Worker now reads users.saved_profile_prev, calls
-- restore_previous_profile(), and relies on the unique profile-name index below.
-- (The Worker also checks the schema version this records.)

-- ── 1. A previous version of the main saved profile (undo) ──────────────────────────────────────
-- Saving a scan over the main profile, or correcting it by hand, used to destroy what was there. The
-- value being replaced is now kept ONE step back, inside the same UPDATE that replaces it (so a second
-- tab cannot slip a write between the snapshot and the change): users.saved_profile_prev is the old
-- saved_profile plus a `replacedAt` stamp. Restoring swaps the two, so a restore can itself be undone.
alter table users add column if not exists saved_profile_prev jsonb;

-- save_profile_from_scan: unchanged contract, plus the snapshot. A write whose resume is identical to
-- the stored one ("Save again" with nothing changed) does not push a copy over a useful older version.
create or replace function save_profile_from_scan(p_user_id uuid, p_profile jsonb, p_replace_edited boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update users
     set saved_profile_prev = case
           when saved_profile is not null and saved_profile ? 'resumeData'
                and (saved_profile -> 'resumeData') is distinct from (p_profile -> 'resumeData')
           then saved_profile || jsonb_build_object('replacedAt', now())
           else saved_profile_prev end,
         saved_profile = p_profile
   where id = p_user_id
     and (p_replace_edited
          or saved_profile is null
          or not (saved_profile ? 'editedAt'));
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- set_saved_profile_resume (version-checked hand edit): same snapshot.
create or replace function set_saved_profile_resume(
  p_user_id uuid, p_resume jsonb, p_edited_at timestamptz, p_expected_version text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update users
     set saved_profile_prev = case
           when (saved_profile -> 'resumeData') is distinct from p_resume
           then saved_profile || jsonb_build_object('replacedAt', now())
           else saved_profile_prev end,
         saved_profile = jsonb_set(
           jsonb_set(saved_profile, '{resumeData}', p_resume),
           '{editedAt}', to_jsonb(p_edited_at))
   where id = p_user_id
     and saved_profile is not null
     and saved_profile ? 'resumeData'
     and (p_expected_version is null
          or (coalesce(saved_profile ->> 'savedAt', '') || '|' || coalesce(saved_profile ->> 'editedAt', ''))
             = p_expected_version);
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- restore_previous_profile: swap the main profile with its previous version. p_expected_replaced_at is
-- the `replacedAt` the person was shown; when the previous version has moved on since (another tab saved
-- or edited), nothing is written and 'conflict' comes back. Returns 'ok' | 'none' | 'conflict'.
create or replace function restore_previous_profile(p_user_id uuid, p_expected_replaced_at text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_main jsonb;
  v_prev jsonb;
begin
  select saved_profile, saved_profile_prev into v_main, v_prev from users where id = p_user_id for update;
  if not found or v_prev is null or not (v_prev ? 'resumeData') then return 'none'; end if;
  if p_expected_replaced_at is not null and coalesce(v_prev ->> 'replacedAt', '') <> p_expected_replaced_at then
    return 'conflict';
  end if;
  update users
     set saved_profile = v_prev - 'replacedAt',
         saved_profile_prev = case
           when v_main is not null and v_main ? 'resumeData' then v_main || jsonb_build_object('replacedAt', now())
           else null end
   where id = p_user_id;
  return 'ok';
end;
$$;

-- clear_saved_profile_source: also clears the pointer on the previous version.
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
  update users
     set saved_profile_prev = jsonb_set(saved_profile_prev, '{sourceScanId}', 'null'::jsonb)
   where id = p_user_id
     and saved_profile_prev is not null
     and saved_profile_prev ->> 'sourceScanId' = any (select x::text from unnest(p_scan_ids) as x);
  update saved_profiles set source_scan_id = null
   where user_id = p_user_id and source_scan_id = any (p_scan_ids);
end;
$$;

-- promote_saved_profile: identical to 0074, plus the previous version is dropped. It was a revision of the
-- profile that is being swapped out (which keeps its own current state as an additional profile), so
-- keeping it would let "restore" put an unrelated old revision on top of the new main profile.
create or replace function promote_saved_profile(p_user_id uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_extra saved_profiles%rowtype;
  v_old   jsonb;
  v_new   jsonb;
  v_label text;
  v_try   text;
  n       int := 1;
begin
  perform pg_advisory_xact_lock(hashtext('saved_profiles:' || p_user_id::text));
  select * into v_extra from saved_profiles where id = p_id and user_id = p_user_id for update;
  if not found then return 'missing'; end if;
  select saved_profile into v_old from users where id = p_user_id for update;

  v_new := jsonb_build_object(
    'resumeData',   v_extra.resume_data,
    'savedAt',      to_jsonb(v_extra.saved_at),
    'sourceScanId', coalesce(to_jsonb(v_extra.source_scan_id), 'null'::jsonb),
    'roleCategory', coalesce(to_jsonb(v_extra.role_category), 'null'::jsonb));
  -- `editedAt` is a marker by presence (save_profile_from_scan asks `saved_profile ? 'editedAt'`).
  if v_extra.edited_at is not null then v_new := v_new || jsonb_build_object('editedAt', to_jsonb(v_extra.edited_at)); end if;

  delete from saved_profiles where id = p_id;

  if v_old is not null and v_old ? 'resumeData' then
    v_label := 'Previous main profile'; v_try := v_label;
    while exists (select 1 from saved_profiles where user_id = p_user_id and lower(label) = lower(v_try)) loop
      n := n + 1; v_try := v_label || ' (' || n || ')';
    end loop;
    insert into saved_profiles (user_id, label, resume_data, role_category, source_scan_id, saved_at, edited_at)
    values (p_user_id, v_try, v_old -> 'resumeData', v_old ->> 'roleCategory',
            nullif(v_old ->> 'sourceScanId', '')::uuid,
            coalesce(nullif(v_old ->> 'savedAt', '')::timestamptz, now()),
            nullif(v_old ->> 'editedAt', '')::timestamptz);
  end if;

  update users set saved_profile = v_new, saved_profile_prev = null where id = p_user_id;
  return 'ok';
end;
$$;

-- ── 2. Profile names are unique per account, enforced by the database ───────────────────────────
-- Uniqueness was only checked by the Worker before the write, so two tabs saving or renaming at once
-- could both pass it and leave two profiles with the same name (indistinguishable in the scan form's
-- picker). Existing duplicates are renamed first (" (2)", " (3)"… in saved order) so the index can build.
do $$
declare
  v_pass int := 0;
begin
  while v_pass < 5 and exists (
    select 1 from saved_profiles group by user_id, lower(label) having count(*) > 1) loop
    update saved_profiles s
       set label = left(s.label, 40 - length(' (' || d.rn || ')')) || ' (' || d.rn || ')'
      from (select id, row_number() over (partition by user_id, lower(label) order by saved_at, id) as rn
              from saved_profiles) d
     where s.id = d.id and d.rn > 1;
    v_pass := v_pass + 1;
  end loop;
end $$;

create unique index if not exists uq_saved_profiles_user_label on saved_profiles (user_id, lower(label));

-- ── 3. scrub_account_data: 0070's body plus the previous profile version ────────────────────────
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

  -- Homepage outcomes (0070): the story is personal text and the credential link points at a page this
  -- same function just disabled, so both go. The outcome ANSWER itself stays, anonymised (the user row
  -- is soft-deleted; nothing below identifies a person), so the published interview rate does not
  -- shrink when someone leaves.
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false
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

  -- Additional saved profiles (0067) and the previous version of the main one (0075) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

  update users set
    deleted_at              = now(),
    email                    = 'deleted-' || p_user_id || '@passthrough.dev',
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    saved_profile_prev       = null,
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

revoke execute on function save_profile_from_scan(uuid, jsonb, boolean) from public, anon, authenticated;
grant  execute on function save_profile_from_scan(uuid, jsonb, boolean) to service_role;
revoke execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant  execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) to service_role;
revoke execute on function restore_previous_profile(uuid, text) from public, anon, authenticated;
grant  execute on function restore_previous_profile(uuid, text) to service_role;
revoke execute on function clear_saved_profile_source(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function clear_saved_profile_source(uuid, uuid[]) to service_role;
revoke execute on function promote_saved_profile(uuid, uuid) from public, anon, authenticated;
grant  execute on function promote_saved_profile(uuid, uuid) to service_role;
revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 75, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 75;   -- never move the version BACKWARDS (a re-run of an older file)
