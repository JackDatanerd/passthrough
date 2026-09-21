-- BUG FIX (Section 5, fixing-time pass): same class of bug that 0017 fixed
-- for `users`, never applied here. employer_leads.email got a *plain*
-- unique constraint in 0013 (`unique (email)`) — case-SENSITIVE, same as
-- `users.email` was before 0017. The app layer has always lowercased new
-- submissions (see the zod schema in employer-leads.controller.js), so any
-- two lowercase submissions of the same address correctly collide and hit
-- the update-on-resubmit path.
--
-- But any row already in the table from *before* that lowercasing was
-- introduced — or written some other way — can still sit there in mixed
-- case. A future lowercase resubmission from that same person won't match
-- it at the DB level (different literal strings), so it creates a brand
-- new row instead of updating the existing one: exactly the duplicate-
-- accumulation problem the 0013 constraint was meant to close, just
-- resurrected for anyone whose original row predates normalization.
--
-- Same two-step fix as 0017: normalize + dedupe existing data, then swap
-- the case-sensitive constraint for a case-insensitive index. Written to be
-- safely re-run.

-- Step 1: lowercase every row's email in place, so duplicates that only
-- differ by case become literal duplicates the next step can find.
update employer_leads set email = lower(email) where email <> lower(email);

-- Step 2: with everything lowercased, any remaining duplicates are the same
-- mailbox written under different casing before this migration — collapse
-- them the same way 0013 collapsed exact duplicates (keep the most recent
-- row per email; created_at then id as the tiebreaker).
delete from employer_leads a
using employer_leads b
where a.email = b.email
  and (a.created_at, a.id) < (b.created_at, b.id);

-- Step 3: the old case-sensitive constraint (0013) no longer does anything
-- useful once every row is lowercase and app writes always lowercase too —
-- drop it and replace with a case-insensitive index, so uniqueness holds at
-- the DB level even against a future code path, a direct SQL edit, or a
-- race between two concurrent inserts, same reasoning as 0017.
alter table employer_leads drop constraint if exists employer_leads_email_key;
create unique index if not exists idx_employer_leads_email_lower_unique on employer_leads (lower(email));
