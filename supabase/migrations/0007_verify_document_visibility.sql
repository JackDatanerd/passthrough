-- Lets the resume owner opt in to exposing the actual .docx and/or PDF
-- files for public download from their verification page — not just the
-- score summary that page already shows. Defaults to OFF for both: someone
-- purchasing a Fix/Badge is opting into a public *score* page by design,
-- but publishing the actual document content is a separate, bigger
-- decision they should make explicitly, not have made for them.
alter table scans add column verify_expose_docx boolean not null default false;
alter table scans add column verify_expose_pdf  boolean not null default false;
