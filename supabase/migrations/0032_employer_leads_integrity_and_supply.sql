-- Employer leads, third pass (Section 5). Safe to re-run.
--
-- 1. verified_candidate_counts() counted REVOKED verification pages as supply.
--    0028 wrote the function against the columns 0025 had just added but never
--    filtered on verification_status, so a credential revoked for a refund, a
--    dispute or by an admin (its public page answers 410) still counted as a
--    "verified candidate" next to the lead asking for that field. Same
--    definition of "verified" as GET /api/verify/:code now: an ACTIVE page.
--    CREATE OR REPLACE keeps the grants 0028 set (service_role only); they are
--    restated so this file reads on its own.
--
-- 2. Historic role data. The verification-page form used to pre-fill its role
--    box with the candidate's category as a display label ("Software
--    Engineering") and post whatever was in it. 0028's cleanup compared
--    role_category to the taxonomy keys case-sensitively, so those rows were
--    moved to role_title with a NULL category — and a lead with no category can
--    never be matched to candidates. The controller normalises this on new
--    submissions (resolveRole); this does the same for the rows 0028 already
--    moved: a role_title that is exactly a taxonomy label becomes the category.
--
-- 3. employer_leads.email is unique on lower(email) (0021) but nothing stopped
--    a mixed-case value being written by hand afterwards; the controller looks
--    a lead up with a plain equality on the lowercased address, so such a row
--    was invisible to it (a resubmission returned success without counting).
--    Normalise, collapse any duplicates the same way 0013/0021 did, then make
--    lowercase a table invariant.

create or replace function verified_candidate_counts()
returns table (role_category text, candidate_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.role_category, count(*)::bigint
  from scans s
  where s.verification_code is not null
    and s.verified_at is not null
    and s.verification_status = 'ACTIVE'
    and s.role_category is not null
    and coalesce(s.fix_ats_score, s.ats_score) >= 80
  group by s.role_category;
$$;

revoke execute on function verified_candidate_counts() from public, anon, authenticated;
grant  execute on function verified_candidate_counts() to service_role;

update employer_leads
set role_category = lower(regexp_replace(btrim(role_title), '[\s-]+', '_', 'g')),
    role_title    = null
where role_category is null
  and role_title is not null
  and lower(regexp_replace(btrim(role_title), '[\s-]+', '_', 'g')) in (
    'software_engineering','product_management','design','data_science',
    'marketing','sales','operations','finance','healthcare','legal','education','other'
  );

update employer_leads set email = lower(email) where email <> lower(email);

delete from employer_leads a
using employer_leads b
where a.email = b.email
  and (a.created_at, a.id) < (b.created_at, b.id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'employer_leads_email_lowercase_chk') then
    alter table employer_leads
      add constraint employer_leads_email_lowercase_chk check (email = lower(email));
  end if;
end $$;
