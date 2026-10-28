-- Document look 4: the hallmark. Additive and idempotent.
--
-- Look 4 keeps look 3's presets, inks and page skeleton and changes how the Passthrough credential is shown on the resume:
-- a logo-derived tile with the check in the header, an optional proof block (QR code + one sentence) at the foot of the last page,
-- and an optional running footer with the verification code. Looks 1-3 keep rendering exactly as they were delivered; scans that
-- exist keep the value they have.
--
-- doc_marks: which of those three marks the OWNER wants on their files. All on by default. Only looks >= 4 read it (design.service.js);
-- a scan on an older look has the column but ignores it. Changing it re-renders both delivered files (PATCH /scan/:id/doc-marks).
--
-- ORDER: deploy the Worker FIRST, then apply this (as 0102 did): a Worker that predates look 4 reads the new default as look 1.

alter table scans add column if not exists doc_marks jsonb not null default '{"header": true, "colophon": true, "footer": true}'::jsonb;

alter table scans drop constraint if exists scans_doc_marks_shape;
alter table scans add constraint scans_doc_marks_shape check (
  jsonb_typeof(doc_marks) = 'object'
  and (doc_marks - 'header' - 'colophon' - 'footer') = '{}'::jsonb
  and coalesce(jsonb_typeof(doc_marks -> 'header'), 'boolean') = 'boolean'
  and coalesce(jsonb_typeof(doc_marks -> 'colophon'), 'boolean') = 'boolean'
  and coalesce(jsonb_typeof(doc_marks -> 'footer'), 'boolean') = 'boolean'
);

alter table scans alter column doc_template_version set default 4;

alter table scans drop constraint if exists scans_doc_template_version_known;
alter table scans add constraint scans_doc_template_version_known check (doc_template_version between 1 and 4);

comment on column scans.doc_template_version is
  'Which document look rules render this scan''s resume and cover letter (1 = original free draw, 2 = signature presets, 3 = signature skeleton, 4 = hallmark). Bump the default and design.service.js LATEST_LOOK together; never edit an old version''s rules.';
comment on column scans.doc_marks is
  'Which Passthrough marks the owner wants on their delivered files (look 4 and later): header badge, last-page proof block, running footer. Absent keys mean on.';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (126, '0126_doc_look_4_marks')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 126, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 126;   -- never move the version BACKWARDS (a re-run of an older file)
