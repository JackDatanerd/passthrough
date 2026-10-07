-- Profile & Dashboard (Section 6), audit round 6. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code: POST /api/profile/save calls save_profile_from_scan(), and
-- without it saving a profile fails.

-- ── save_profile_from_scan ──────────────────────────────────────────────────
-- Saving a profile from a scan REPLACES users.saved_profile wholesale — including any
-- corrections the person made in the Settings editor (PUT /api/profile stamps `editedAt`).
-- The write used to be an unconditional UPDATE, so "Save again" / "Replace saved profile" on a
-- scan page silently threw those corrections away. This makes the decision atomic, in one
-- statement: a profile that carries `editedAt` is replaced only when the caller says so
-- explicitly (p_replace_edited), so an edit made in a second tab between the check and the
-- write can never be lost either.
--
-- Returns true when the profile was written, false when it was NOT because the existing one has
-- hand edits and p_replace_edited was false.
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
     set saved_profile = p_profile
   where id = p_user_id
     and (p_replace_edited
          or saved_profile is null
          or not (saved_profile ? 'editedAt'));
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function save_profile_from_scan(uuid, jsonb, boolean) from public, anon, authenticated;
grant  execute on function save_profile_from_scan(uuid, jsonb, boolean) to service_role;
