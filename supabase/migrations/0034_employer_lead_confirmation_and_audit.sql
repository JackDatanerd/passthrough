-- 0034_employer_lead_confirmation_and_audit.sql
-- Employer leads (Section 5), fix round. Idempotent — safe to re-run.
--
-- 1. employer_leads.confirmed_at — proof the address belongs to the person who
--    typed it. The lead form is public and the acknowledgement promises "we'll
--    email you when there are Verified candidates"; until now anyone could put
--    anyone's address on that list and the only way out was emailing support.
--    The acknowledgement now carries a signed confirm link (stateless — see
--    src/lib/leadTokens.js, so no token column is needed) and confirming sets
--    this timestamp. Leads that existed before this migration stay NULL
--    (unconfirmed) rather than being marked confirmed on nobody's word; admin-
--    entered leads (source 'manual') are backfilled, because an admin typed
--    them in from a conversation they had.
--
-- 2. employer_lead_suppressions — "remove me" must stick. The removal link
--    deletes the lead AND records a hash of the address here; the public form
--    silently ignores suppressed addresses, so a stranger cannot put a removed
--    person straight back on the list. Stored as a SHA-256 hash: the point of
--    the table is to remember "do not contact", not to keep the address.
--
-- 3. admin_audit_log — append-only record of admin actions on other people's
--    data (lead edits, deletes, bulk changes, exports). `detail` never holds
--    personal data, only ids / counts / field names.
--
-- 4. verified_candidate_counts() counted scans, not people. One candidate with
--    two badged scans in the same field was "2 verified candidates", inflating
--    the admin chips and firing the owner digest on a repeat badge. Now
--    distinct users. (Anonymous scans cannot hold a badge, so user_id is
--    always set for a verified scan; the filter just makes that explicit.)
--
-- 5. open_lead_counts() — waiting leads per field, computed in the database.
--    The lead-match sweep used to SELECT up to 5000 rows and count in JS, but
--    PostgREST caps a response at its max-rows (1000 by default), so the
--    "limit" was fiction and counts silently topped out.

alter table employer_leads add column if not exists confirmed_at timestamptz;

update employer_leads
   set confirmed_at = created_at
 where source = 'manual' and confirmed_at is null;

create table if not exists employer_lead_suppressions (
  email_hash text primary key,
  created_at timestamptz not null default now()
);
alter table employer_lead_suppressions enable row level security;   -- service-role only, like every table (0014)

create table if not exists admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references users(id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_admin_audit_log_created on admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_log_target  on admin_audit_log (target_type, target_id);
alter table admin_audit_log enable row level security;

create or replace function verified_candidate_counts()
returns table (role_category text, candidate_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.role_category, count(distinct s.user_id)::bigint
  from scans s
  where s.verification_code is not null
    and s.verified_at is not null
    and s.verification_status = 'ACTIVE'
    and s.user_id is not null
    and s.role_category is not null
    and coalesce(s.fix_ats_score, s.ats_score) >= 80
  group by s.role_category;
$$;

revoke execute on function verified_candidate_counts() from public, anon, authenticated;
grant  execute on function verified_candidate_counts() to service_role;

create or replace function open_lead_counts()
returns table (role_category text, lead_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select l.role_category, count(*)::bigint
  from employer_leads l
  where l.status in ('NEW', 'CONTACTED')
    and l.role_category is not null
  group by l.role_category;
$$;

revoke execute on function open_lead_counts() from public, anon, authenticated;
grant  execute on function open_lead_counts() to service_role;
