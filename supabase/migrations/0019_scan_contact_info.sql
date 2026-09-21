-- Section audit: "generate a resume from scratch" (brain-dump entry path).
--
-- ScanForm.jsx already collects contactName/contactEmail from anonymous
-- brain-dump submitters ("so your resume header isn't blank" — see that
-- component). Until now those values were only ever folded into the raw
-- brain-dump text as a "Name: X\nEmail: Y" preamble for Claude's structuring
-- pass to pick up — never persisted as their own columns, which meant the
-- one piece of infrastructure that could have used a validated anonymous
-- email address for something more useful (recovering an anon scan whose
-- localStorage token got lost) had no durable value to read.
--
-- Purely additive — both nullable, no backfill needed (every existing row
-- predates this column and simply has null here, which is correct: we have
-- no way to recover what was typed into a pre-migration brain dump's
-- preamble short of re-parsing raw_brain_dump_text, which isn't worth doing
-- for a couple of contact fields).

alter table scans
  add column contact_name  text,
  add column contact_email text;
-- Populated only for anonymous (user_id is null) brain_dump submissions —
-- see scan.controller.js's createScan. Used by runAtsScan to send a
-- "here's your scan" recovery email once scoring completes, so losing the
-- anon_token client-side doesn't mean losing access to a resume someone
-- just spent real effort typing out. Never populated for logged-in users
-- (their account email is already the right place to send to) or for
-- file/saved_profile input modes (nothing to recover that isn't already
-- sitting in their own original file or account).
