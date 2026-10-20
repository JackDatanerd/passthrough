-- Document look versioning (applicant documents). Additive and idempotent.
--
-- A delivered resume's colours and type are not stored: they are RE-DERIVED every time the file is rendered (the PDF, the DOCX,
-- the cover letter, a regenerate, a re-download), from the scan's ids and role category (design.service.js getDesignTokens).
-- That is safe only while the rules never change - and the signature-look work changes them: every role category now gets one
-- of a few designed presets instead of a free draw from 19 palettes and 8 type pairings. Without a version, that change would
-- silently re-colour every document already delivered the next time anyone re-rendered it, and the PDF the customer emailed to
-- an employer would no longer match the one they regenerate (or the one the verification page describes).
--
-- scans.doc_template_version names the rule set a scan's documents are rendered with:
--   1 = the original free draw (frozen; design.service.js keeps it byte-for-byte)
--   2 = the signature presets
-- Every scan that exists now keeps 1. Every scan created from here on gets 2 (the column default), so the Worker needs no change
-- at the insert sites and the migration is safe to apply before or after the code. A Worker that predates the column renders
-- version 1, which is what every existing row is.

alter table scans add column if not exists doc_template_version smallint not null default 1;   -- existing rows are backfilled with 1
alter table scans alter column doc_template_version set default 2;                            -- new rows from here on

alter table scans drop constraint if exists scans_doc_template_version_known;
alter table scans add constraint scans_doc_template_version_known check (doc_template_version between 1 and 2);

comment on column scans.doc_template_version is
  'Which document look rules render this scan''s resume and cover letter (1 = original free draw, 2 = signature presets). Bump the default and design.service.js LATEST_LOOK together; never edit an old version''s rules.';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (101, '0101_doc_template_version')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 101, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 101;   -- never move the version BACKWARDS (a re-run of an older file)
