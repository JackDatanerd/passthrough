-- Document look 3: the signature PDF skeleton. Additive and idempotent.
--
-- 0101 versioned the rules that colour and set the type of a scan's documents. Look 3 is a new PDF SKELETON (a designed header with the
-- credential seal, role / employer / dates hierarchy, a header and heading treatment per preset, spacing that follows how full the
-- page is) drawn by pdfSignature.service.js. Looks 1 and 2 keep rendering on the original skeleton, so a document already delivered
-- comes back exactly as it left: scans that exist keep the value they have (1, or 2 for the few created between 0101 and now).
--
-- From here on a new scan gets 3 (the column default), so the Worker needs no change at the insert sites. ORDER MATTERS the other way
-- round from 0101: deploy the Worker FIRST, then apply this. A Worker that predates look 3 does not know the value and reads it as 1
-- (design.service.js resolveLook), so scans created in the gap would be drawn on the original look until the Worker is updated.

alter table scans alter column doc_template_version set default 3;

alter table scans drop constraint if exists scans_doc_template_version_known;
alter table scans add constraint scans_doc_template_version_known check (doc_template_version between 1 and 3);

comment on column scans.doc_template_version is
  'Which document look rules render this scan''s resume and cover letter (1 = original free draw, 2 = signature presets, 3 = signature skeleton). Bump the default and design.service.js LATEST_LOOK together; never edit an old version''s rules.';

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (102, '0102_doc_look_3')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 102, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 102;   -- never move the version BACKWARDS (a re-run of an older file)
