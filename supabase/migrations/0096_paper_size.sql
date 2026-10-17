-- The page size of a scan's delivered documents (resume .docx / .pdf, cover letter), chosen by the person.
-- Until now it was only guessed from the job posting (design.service.js detectPaper), and a wrong guess - a US posting that
-- mentions a UK office, a Canadian one in "London, Ontario", an applicant in Nairobi applying to a firm with no country in
-- the text - meant files that print on the wrong paper with no way to correct it.
--
-- scans.paper_size - 'letter' (US Letter) or 'a4'. NULL = not chosen: the posting decides, exactly as before.
--
-- It is a preference, nothing personal, so it survives an account deletion like the other scan settings (the scrub test lists it).
-- The code writes the column only when the person picked a size, and reads it best-effort on the cover-letter download, so the
-- worker may be deployed before or after this migration.

alter table scans add column if not exists paper_size text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'scans_paper_size_check') then
    alter table scans add constraint scans_paper_size_check check (paper_size is null or paper_size in ('letter', 'a4'));
  end if;
end $$;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (96, '0096_paper_size')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 96, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 96;   -- never move the version BACKWARDS (a re-run of an older file)
