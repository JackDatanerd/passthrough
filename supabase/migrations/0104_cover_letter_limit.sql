-- Cover-letter limit (migration 0104).
--
-- A cover letter is written by a paid model call, and "Write a new one" had no ceiling: only a time-based rate limit stood
-- between a $9 purchase and an unbounded number of calls. scans.cover_letter_count counts the letters written for a scan,
-- and the Worker refuses a new one once the count reaches the tier's limit (config/constants.js COVER_LETTER_LIMITS).
--
-- The count is claimed BEFORE the model is called and released if no letter comes out of it, so a failed call never costs
-- the buyer one. Both steps are single statements, so two concurrent requests cannot both take the last slot.
--
-- Safe to apply before or after the Worker: the column defaults to 0, and a Worker that predates the functions simply never
-- calls them; a Worker that postdates them but runs before this file is applied treats the missing function as "no limit
-- yet" rather than refusing every letter.

alter table scans add column if not exists cover_letter_count int not null default 0;

-- Letters that already exist count as one, so the first "Write a new one" after this migration is counted correctly.
update scans set cover_letter_count = 1 where cover_letter_text is not null and cover_letter_count = 0;

-- Takes one slot if the scan is the caller's, is delivered, and is under p_max. Returns the new count, or -1 when there was
-- no slot to take (at the limit, not the caller's, not delivered).
create or replace function claim_cover_letter_slot(p_scan_id uuid, p_user_id uuid, p_max int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update scans
  set cover_letter_count = cover_letter_count + 1
  where id = p_scan_id
    and user_id = p_user_id
    and status = 'FIX_DELIVERED'
    and cover_letter_count < p_max
  returning cover_letter_count into v_count;

  return coalesce(v_count, -1);
end;
$$;

-- Gives a slot back (the model call failed, or the letter could not be stored). Never goes below zero.
create or replace function release_cover_letter_slot(p_scan_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update scans set cover_letter_count = greatest(cover_letter_count - 1, 0) where id = p_scan_id;
$$;

revoke execute on function claim_cover_letter_slot(uuid, uuid, int) from public, anon, authenticated;
grant  execute on function claim_cover_letter_slot(uuid, uuid, int) to service_role;
revoke execute on function release_cover_letter_slot(uuid) from public, anon, authenticated;
grant  execute on function release_cover_letter_slot(uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (104, '0104_cover_letter_limit')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 104, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 104;   -- never move the version BACKWARDS (a re-run of an older file)
