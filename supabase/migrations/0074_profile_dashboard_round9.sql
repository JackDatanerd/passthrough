-- Profile & Dashboard (Section 6), audit round 9. Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code: the Worker now calls promote_saved_profile(), reads
-- users.notify_outcome_followup, and sends label-only renames through update_saved_profile() with a
-- NULL resume. (The Worker also checks the schema version this records.)

-- ── 1. update_saved_profile: a rename must not touch the resume ─────────────────────────────────
-- The Worker used to read the resume, then write that copy straight back with a new edit stamp to
-- rename a profile: an edit landing in between was overwritten, and every rename made the profile look
-- hand-edited (and moved its version, so an open editor got a false "changed elsewhere"). A NULL resume
-- now means "rename only": the stored resume and its edit stamp stay exactly as they are.
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
         edited_at   = case when p_resume is null then edited_at else p_edited_at end
   where id = p_id and user_id = p_user_id
     and (p_expected_version is null or coalesce(edited_at, saved_at) = p_expected_version);
  get diagnostics v_rows = row_count;
  if v_rows > 0 then return 'ok'; end if;
  if exists (select 1 from saved_profiles where id = p_id and user_id = p_user_id) then return 'conflict'; end if;
  return 'missing';
end;
$$;

-- ── 2. promote_saved_profile: make an additional profile the main one ───────────────────────────
-- One transaction under the same per-user lock add_saved_profile takes: the extra becomes
-- users.saved_profile, and the previous main profile (if any) takes its place as an additional profile,
-- so the number of profiles never changes and nothing is lost. Returns 'ok' or 'missing'.
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

  update users set saved_profile = v_new where id = p_user_id;
  return 'ok';
end;
$$;

revoke execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
grant  execute on function update_saved_profile(uuid, uuid, jsonb, text, timestamptz, timestamptz) to service_role;
revoke execute on function promote_saved_profile(uuid, uuid) from public, anon, authenticated;
grant  execute on function promote_saved_profile(uuid, uuid) to service_role;

-- ── 3. scan_outcomes survives the deletion of its scan ──────────────────────────────────────────
-- scan_id was the primary key with ON DELETE CASCADE, so deleting a scan (one, a selection, a filter or
-- the whole history) silently deleted the person's interview answer AND any published success story,
-- and shrank the public interview rate — the opposite of what account deletion deliberately does
-- (scrub_account_data keeps the anonymised answer). Now: the row gets its own id, scan_id becomes a
-- nullable unique reference (ON DELETE SET NULL), and a BEFORE DELETE trigger on scans scrubs the
-- story text first (it is personal text about a scan that no longer exists, and an approved one is
-- public). The answer itself stays.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'scan_outcomes' and column_name = 'id') then
    alter table scan_outcomes drop constraint if exists scan_outcomes_scan_id_fkey;
    alter table scan_outcomes drop constraint if exists scan_outcomes_pkey;
    alter table scan_outcomes add column id uuid not null default gen_random_uuid();
    alter table scan_outcomes add constraint scan_outcomes_pkey primary key (id);
    alter table scan_outcomes alter column scan_id drop not null;
    alter table scan_outcomes add constraint scan_outcomes_scan_id_key unique (scan_id);
    alter table scan_outcomes add constraint scan_outcomes_scan_id_fkey
      foreign key (scan_id) references scans(id) on delete set null;
  end if;
end $$;

create or replace function scrub_outcome_story_on_scan_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false,
    updated_at            = now()
  where scan_id = old.id and (story_status <> 'NONE' or story_consent);
  return old;
end;
$$;

drop trigger if exists scans_scrub_outcome_story_trg on scans;
create trigger scans_scrub_outcome_story_trg
  before delete on scans
  for each row execute function scrub_outcome_story_on_scan_delete();

-- ── 4. notify_outcome_followup ──────────────────────────────────────────────────────────────────
-- The one-time "did your fixed resume lead to an interview?" email was governed by the scan-result
-- toggle, so nobody could keep one and drop the other. Its own preference now; accounts that had
-- switched result emails off keep that choice (backfilled once, when the column is added).
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'users' and column_name = 'notify_outcome_followup') then
    alter table users add column notify_outcome_followup boolean not null default true;
    update users set notify_outcome_followup = false where notify_scan_results = false;
  end if;
end $$;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 74, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
