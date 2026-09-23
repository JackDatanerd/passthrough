-- Employer leads, second pass (Section 5). Purely additive except for the two
-- clearly-marked data cleanups below. Safe to re-run.
--
-- Written after 0023_lock_down_rpc_execute_grants.sql, which revoked the
-- platform's default EXECUTE grant on every function in this schema and made
-- future functions un-callable by anon/authenticated by default. The new
-- verified_candidate_counts() function below follows that same posture
-- explicitly, rather than accidentally relying on whatever the default was.
--
-- Renumbered repeatedly from this session's own original draft (0024/0025,
-- then 0026/0027, then 0027/0028) as the live repo kept claiming those
-- numbers for unrelated, concurrent work: payment refunds, a Section 7/8
-- audit (whose own 0025 added employer_leads.source_code for the exact same
-- "which verification page" attribution this pass was independently about
-- to add under a different column name — kept as-is; this migration writes
-- source_code, not a second column), a Section 9/10 audit (0026, an
-- unrelated scrub_account_data completeness fix — see 0030's own comment for
-- more on that one), and a Scan/ATS audit (0027, unrelated). Starts
-- numbering from where the live repo actually left off (0028).
--
-- 1. Role taxonomy. `role_category` was documented and displayed as the same
--    thing as scans.role_category (a fixed list: software_engineering,
--    sales, ...), but the public form fed it free text ("Senior Engineer"),
--    so no lead could ever be matched against the candidates it was promised
--    ("we'll reach out when we have candidates matching your role").
--    role_category now only ever holds a taxonomy value; the free text moves
--    to role_title. Existing rows are split accordingly below.
--
-- 3. Resubmissions. A repeat submission used to silently overwrite the
--    lead's name/company/role (anyone who knew an employer's address could
--    rewrite that lead) and wipe role_category when the optional field was
--    left blank. The controller now only fills blanks, and records the
--    resubmission here instead: submission_count / last_submitted_at let the
--    admin list surface re-engaged leads, which used to be invisible.
--
-- 4. contacted_at — set the first time a lead moves to CONTACTED, so
--    "how long did we sit on this lead" is answerable.

alter table employer_leads add column if not exists role_title         text;
alter table employer_leads add column if not exists submission_count   int         not null default 1;
alter table employer_leads add column if not exists last_submitted_at  timestamptz not null default now();
alter table employer_leads add column if not exists contacted_at       timestamptz;

-- Existing rows: last_submitted_at should reflect when the lead actually came
-- in (the column default only stamps the moment this migration ran). Only
-- touches never-resubmitted rows, so re-running it can't rewind a real one.
update employer_leads set last_submitted_at = created_at
where submission_count = 1
  and last_submitted_at > created_at + interval '1 minute';

-- DATA CLEANUP (1/2): free-text values that were stored in role_category are
-- job titles, not categories. Move them (only rows not already a taxonomy
-- value, and not already migrated).
update employer_leads
set role_title = role_category, role_category = null
where role_category is not null
  and role_title is null
  and role_category not in (
    'software_engineering','product_management','design','data_science',
    'marketing','sales','operations','finance','healthcare','legal','education','other'
  );

create index if not exists idx_employer_leads_last_submitted on employer_leads (last_submitted_at desc);
create index if not exists idx_employer_leads_role_category  on employer_leads (role_category);

-- DATA CLEANUP (2/2): every new employer lead used to be written to
-- alert_logs — the table behind "Recent alerts" / "Alert history", which is
-- documented as the record of CRITICAL failures (payment/webhook errors,
-- ledger failures, signature mismatches). Lead notifications are not alerts:
-- they buried real incidents in the 5-row dashboard panel, and they copied
-- each lead's name/email/company into a table with no delete path (deleting a
-- lead in the admin UI left that personal data behind). The controller no
-- longer writes them; this removes the ones already there. The leads
-- themselves are untouched (they live in employer_leads).
delete from alert_logs where subject = 'New employer lead';

-- Verified-candidate supply per role category, for the admin leads list
-- ("we have N verified candidates in the field this employer asked about").
-- 80 mirrors ATS_BADGE_THRESHOLD in src/config/constants.js. Same definer +
-- pinned search_path convention as 0015.
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
    and s.role_category is not null
    and coalesce(s.fix_ats_score, s.ats_score) >= 80
  group by s.role_category;
$$;

revoke execute on function verified_candidate_counts() from public, anon, authenticated;
grant  execute on function verified_candidate_counts() to service_role;
