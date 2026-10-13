-- Renumbered from 0076 (database round 2): two files shared 0076, which the numeric-prefix migration history of `supabase db push`
-- cannot hold, and the single schema_version integer could not tell that one of them was missing. The SQL below is unchanged
-- and idempotent, so a database that already applied it as 0076 loses nothing by running it again.
--
-- Profile & Dashboard round 11.
--
-- The dashboard list shows a scan's score as the FIXED score once a fix is purchased and scored
-- (fix_ats_score), otherwise the original (ats_score). "Highest score" / "Lowest score" sorted by
-- ats_score alone, so a scan that went 52 -> 88 was displayed as 88 but ordered as 52.
-- display_score is exactly what the row shows, stored so it can be ordered and indexed.
alter table scans
  add column if not exists display_score int
  generated always as (
    case when fix_purchased and fix_ats_score is not null then fix_ats_score else ats_score end
  ) stored;

create index if not exists idx_scans_user_display_score
  on scans (user_id, display_score desc nulls last, created_at desc);

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 81, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
