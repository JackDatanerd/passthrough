-- 0054_employer_leads_round6.sql
-- Employer leads (Section 5), independent audit round 6. Idempotent — safe to re-run.
--
-- 1. last_ack_at / last_notice_at — the resubmission cooldowns (10 min for the confirmation
--    email, 24 h for the owner's "resubmitted" notice) used to be measured from
--    last_submitted_at, which EVERY resubmission resets. A person retrying every few minutes
--    because the first email never arrived therefore kept the clock from ever expiring and was
--    never sent a second one. The clocks now run from when the email/notice actually went out.
--    Nullable, no backfill: the controller falls back to created_at for rows that predate this.
--
-- 2. last_candidates_notified_at — when an admin last told this lead "there are Verified
--    candidates in your field" (POST /api/employer-leads/notify-candidates). Lets the action
--    skip leads already told recently, so pressing it twice never mails anyone twice.
--
-- 3. uncategorised_lead_counts() — open leads with NO field. open_lead_counts() deliberately
--    groups by field, so a lead nobody categorised could never be matched and never showed up
--    in the owner digest. This is the count of those (open = NEW or CONTACTED; confirmed_count
--    is the subset whose address is confirmed). Same definer + service_role-only posture as
--    open_lead_counts().

alter table employer_leads add column if not exists last_ack_at                 timestamptz;
alter table employer_leads add column if not exists last_notice_at              timestamptz;
alter table employer_leads add column if not exists last_candidates_notified_at timestamptz;

create or replace function uncategorised_lead_counts()
returns table (lead_count bigint, confirmed_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::bigint,
         (count(*) filter (where l.confirmed_at is not null))::bigint
  from employer_leads l
  where l.status in ('NEW', 'CONTACTED')
    and l.role_category is null;
$$;

revoke execute on function uncategorised_lead_counts() from public, anon, authenticated;
grant  execute on function uncategorised_lead_counts() to service_role;
