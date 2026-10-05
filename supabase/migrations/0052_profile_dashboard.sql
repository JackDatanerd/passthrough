-- Profile & Dashboard (Section 6), audit round 5. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code. Without it the new preference toggle cannot be saved and
-- the scan-result email check reads an absent column as "on" (the old behaviour).

-- ── notify_scan_results ─────────────────────────────────────────────────────
-- Every registered account was emailed a pass/fail message for every free scan, with no way
-- to turn it off. Security and transactional mail (password, email change, receipts, a
-- delivered fix) is NOT governed by this — only the "your scan finished" result email.
alter table users add column if not exists notify_scan_results boolean not null default true;

-- ── clear_saved_profile_source ──────────────────────────────────────────────
-- Deleting a scan must clear the saved profile's "view source scan" pointer when it points
-- at the scan being removed. deleteScan used to read the whole saved_profile, then write the
-- whole old copy back with the pointer nulled — a profile saved or edited between the read
-- and the write (a second tab, the new profile editor) was silently replaced by the stale
-- copy. This changes ONLY the pointer, in one statement, and only if it still points at one
-- of the deleted scans.
create or replace function clear_saved_profile_source(p_user_id uuid, p_scan_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  update users
     set saved_profile = jsonb_set(saved_profile, '{sourceScanId}', 'null'::jsonb)
   where id = p_user_id
     and saved_profile is not null
     and saved_profile ->> 'sourceScanId' = any (select x::text from unnest(p_scan_ids) as x);
$$;

revoke execute on function clear_saved_profile_source(uuid, uuid[]) from public, anon, authenticated;
grant  execute on function clear_saved_profile_source(uuid, uuid[]) to service_role;

-- ── set_saved_profile_resume ────────────────────────────────────────────────
-- PUT /api/profile (the saved-profile editor) replaces ONLY the resume content and stamps
-- editedAt. Done in SQL so it cannot clobber the other keys of the same jsonb value
-- (sourceScanId, roleCategory, savedAt) with a stale copy if one of them changed meanwhile —
-- the same read-modify-write trap clear_saved_profile_source closes for the pointer.
-- Returns false when there is no saved profile to edit.
create or replace function set_saved_profile_resume(p_user_id uuid, p_resume jsonb, p_edited_at timestamptz)
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
     and saved_profile ? 'resumeData';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function set_saved_profile_resume(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant  execute on function set_saved_profile_resume(uuid, jsonb, timestamptz) to service_role;
