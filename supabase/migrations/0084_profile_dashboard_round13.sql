-- Profile & Dashboard (Section 6), audit round 13. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the Worker (the Worker also checks the schema version and the migration ledger this records).
-- The old Worker keeps working against this migration: every parameter added here has a default.
--
-- The "edited" marker (users.saved_profile ->> 'editedAt', saved_profiles.edited_at) is what makes "save from a scan"
-- ask before it replaces a profile somebody corrected by hand. Two paths left it wrong.
--
-- 1. add_saved_profile: "Copy as another profile" copied the resume but not the marker, so the copy looked untouched.
--    Make that copy the main profile and a later save from a scan replaced the hand corrections WITHOUT asking.
--    p_edited_at carries the marker over (NULL, the default, is what saving from a scan passes: nothing was edited).
--    The signature changes, so the old one is dropped first: two overloads that differ only by a defaulted
--    trailing parameter make a named-argument RPC call ambiguous.
--
-- 2. set_saved_profile_resume / update_saved_profile: stamped the marker on every save, including one that wrote back
--    exactly what was already stored (opening the editor and pressing Save). The profile then read "edited <date>"
--    and the next save from a scan asked for a confirmation nobody had earned. An unchanged resume now leaves the
--    marker, the stored profile, the earlier version and the version token exactly as they were. The version check
--    still runs, so a stale editor still gets its conflict.

-- ── 1. add_saved_profile ────────────────────────────────────────────────────
drop function if exists add_saved_profile(uuid, text, jsonb, text, uuid, int);

create or replace function add_saved_profile(
  p_user_id uuid, p_label text, p_resume jsonb, p_role_category text, p_source_scan_id uuid, p_max int,
  p_edited_at timestamptz default null)
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
  insert into saved_profiles (user_id, label, resume_data, role_category, source_scan_id, edited_at)
  values (p_user_id, p_label, p_resume, p_role_category, p_source_scan_id, p_edited_at)
  returning id into v_id;
  return v_id;
end;
$$;

-- ── 2a. set_saved_profile_resume: an unchanged resume is not an edit ────────
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
         saved_profile = case
           when (saved_profile -> 'resumeData') is distinct from p_resume
           then jsonb_set(
                  jsonb_set(saved_profile, '{resumeData}', p_resume),
                  '{editedAt}', to_jsonb(p_edited_at))
           else saved_profile end
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

-- ── 2b. update_saved_profile: same rule for an additional profile ───────────
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
     set resume_data = coalesce(p_resume, resume_data),
         label       = coalesce(p_label, label),
         edited_at   = case
                         when p_resume is null or p_resume is not distinct from resume_data then edited_at
                         else p_edited_at end
   where id = p_id and user_id = p_user_id
     and (p_expected_version is null or coalesce(edited_at, saved_at) = p_expected_version);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'ok'; end if;
  if exists (select 1 from saved_profiles where id = p_id and user_id = p_user_id) then return 'conflict'; end if;
  return 'missing';
end;
$$;

-- Service role only, like every definer function here (0015, 0077).
revoke execute on function add_saved_profile(uuid, text, jsonb, text, uuid, int, timestamptz) from public, anon, authenticated;
grant  execute on function add_saved_profile(uuid, text, jsonb, text, uuid, int, timestamptz) to service_role;
revoke execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant  execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) to service_role;
revoke execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (84, '0084_profile_dashboard_round13')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 84, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 84;   -- never move the version BACKWARDS (a re-run of an older file)
