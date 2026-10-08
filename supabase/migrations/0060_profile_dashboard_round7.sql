-- Profile & Dashboard (Section 6), audit round 7. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code (the Worker also checks the schema version this records): PUT /api/profile now calls the four-argument
-- set_saved_profile_resume() below. (The old three-argument version is dropped here, so a Worker
-- still running the previous code cannot save a profile edit between this migration and the deploy
-- — keep that window short.)

-- ── set_saved_profile_resume (version-checked) ──────────────────────────────
-- 0052 replaced ONLY the resume content of the saved profile and stamped editedAt, but it wrote
-- whatever draft it was handed with no idea which version of the profile that draft was made from.
-- Tab A opens the editor; tab B saves a different scan (replacing the profile) or edits it; tab A
-- saves — and its stale draft landed on top of the NEW profile's sourceScanId / savedAt /
-- roleCategory, so the content no longer matched the scan it claimed to come from.
--
-- p_expected_version is the profile's version as GET /api/profile/data reported it:
-- "<savedAt>|<editedAt or empty>". When it is given, the write happens only if the stored profile
-- still has exactly that version — decided in the same UPDATE, so a change landing between a read
-- and this write cannot slip through. NULL keeps the old unconditional behaviour (older clients).
-- Returns false when nothing was written (no saved profile, OR the version no longer matches —
-- the caller reads the row afterwards to tell the two apart).
drop function if exists set_saved_profile_resume(uuid, jsonb, timestamptz);

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
     set saved_profile = jsonb_set(
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

revoke execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) from public, anon, authenticated;
grant  execute on function set_saved_profile_resume(uuid, jsonb, timestamptz, text) to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 60, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
