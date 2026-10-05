-- Employer leads (Section 5), fresh audit pass 2.
--
-- 1. verified_candidate_counts() hard-coded `>= 80` while the app's rule lives in
--    constants.js (ATS_BADGE_THRESHOLD). They agree today and would drift the day the
--    threshold changes, making the admin's supply figure and the owner digest disagree
--    with what the public verification page calls "verified". The threshold is now a
--    parameter (default 80, so a caller that passes nothing behaves as before); the
--    app passes ATS_BADGE_THRESHOLD. The zero-argument version is dropped first: two
--    overloads, one with a defaulted parameter, make PostgREST's rpc() ambiguous.
--
-- 2. open_lead_counts() counted unconfirmed addresses as waiting leads, so the owner
--    digest announced "N open leads" that included strangers' typos and bots. It now also
--    returns confirmed_count; the digest announces on CONFIRMED leads and shows the
--    unconfirmed ones separately. lead_count keeps its meaning (open = NEW or CONTACTED).
--
-- 3. Partial index for the retention purge of long-unconfirmed leads (see
--    retention.service.js): only rows that are still candidates for deletion.

drop function if exists verified_candidate_counts();

create or replace function verified_candidate_counts(p_min_score numeric default 80)
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
    and coalesce(s.fix_ats_score, s.ats_score) >= p_min_score
  group by s.role_category;
$$;

revoke execute on function verified_candidate_counts(numeric) from public, anon, authenticated;
grant  execute on function verified_candidate_counts(numeric) to service_role;

drop function if exists open_lead_counts();

create or replace function open_lead_counts()
returns table (role_category text, lead_count bigint, confirmed_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select l.role_category,
         count(*)::bigint,
         (count(*) filter (where l.confirmed_at is not null))::bigint
  from employer_leads l
  where l.status in ('NEW', 'CONTACTED')
    and l.role_category is not null
  group by l.role_category;
$$;

revoke execute on function open_lead_counts() from public, anon, authenticated;
grant  execute on function open_lead_counts() to service_role;

create index if not exists idx_employer_leads_stale_unconfirmed
  on employer_leads (last_submitted_at)
  where confirmed_at is null and status = 'NEW' and notes is null;
