-- Homepage evidence layer (migration 0070).
--
-- The homepage now makes claims ("N resumes scanned", "X% of applicants report an interview", real stories,
-- hot fields). Until now nothing recorded the facts behind any of them. This migration adds them:
--
-- 1. scan_outcomes — what a person tells us about a delivered fix: did it lead to an interview, how
--    many, how fast, and (optionally, with explicit consent) a story we may publish. A story is never
--    public until an admin approves it, and any later edit by its author sends it back to review.
-- 2. scans.outcome_prompted_at / outcome_prompt_attempts — bookkeeping for the follow-up email sweep,
--    so each delivered fix is asked about once (bounded retries on a failed send), not every hour.
-- 3. A running counter of completed scans (a trigger on scans). Counting rows is wrong: anonymous
--    scans are purged after 24h and people delete their history, so the table undercounts forever.
-- 4. public_home_stats() / public_hot_categories(): the only two aggregations the public endpoint
--    reads. Both enforce minimum counts so a small number can never single anyone out.
-- 5. scrub_account_data redefined (0067's body + the story scrub).

create table if not exists scan_outcomes (
  scan_id               uuid primary key references scans(id) on delete cascade,
  user_id               uuid references users(id),
  role_category         text,
  outcome               text not null check (outcome in ('INTERVIEW', 'NO_INTERVIEW', 'STILL_APPLYING')),
  interview_count       smallint check (interview_count between 1 and 99),
  interview_after_days  smallint check (interview_after_days between 0 and 365),
  story_consent         boolean not null default false,
  story_status          text not null default 'NONE' check (story_status in ('NONE', 'PENDING', 'APPROVED', 'REJECTED')),
  story_display_name    text check (char_length(story_display_name) <= 40),
  story_quote           text check (char_length(story_quote) <= 160),
  story_text            text check (char_length(story_text) <= 1200),
  story_show_credential boolean not null default false,
  story_moderated_at    timestamptz,
  story_moderated_by    uuid references users(id),
  answered_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A story only exists with consent, and interview details only belong to an interview.
  constraint scan_outcomes_story_needs_consent check (story_status = 'NONE' or story_consent),
  constraint scan_outcomes_interview_details check (outcome = 'INTERVIEW' or (interview_count is null and interview_after_days is null))
);

create index if not exists scan_outcomes_answered_idx   on scan_outcomes (outcome, answered_at);
create index if not exists scan_outcomes_category_idx   on scan_outcomes (role_category, answered_at) where outcome = 'INTERVIEW';
create index if not exists scan_outcomes_review_idx     on scan_outcomes (story_status, answered_at) where story_status in ('PENDING', 'APPROVED');
create index if not exists scan_outcomes_user_idx       on scan_outcomes (user_id);

alter table scan_outcomes enable row level security;   -- service role only, like every other table (0014)

alter table scans add column if not exists outcome_prompted_at      timestamptz;
alter table scans add column if not exists outcome_prompt_attempts  smallint not null default 0;

-- The sweep's working set: delivered fixes nobody has asked about yet.
create index if not exists scans_outcome_prompt_idx
  on scans (fix_generated_at)
  where fix_purchased and fix_generated_at is not null and outcome_prompted_at is null and user_id is not null;

-- ── running count of completed scans ──────────────────────────────────────────
insert into system_state (key, value)
select 'scans_completed_total', jsonb_build_object('count', (select count(*) from scans where scan_completed_at is not null))
on conflict (key) do nothing;

create or replace function bump_scans_completed_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.scan_completed_at is null and new.scan_completed_at is not null then
    insert into system_state (key, value)
    values ('scans_completed_total', jsonb_build_object('count', 1))
    on conflict (key) do update
      set value = jsonb_build_object('count', coalesce((system_state.value ->> 'count')::bigint, 0) + 1),
          updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists scans_completed_total_trg on scans;
create trigger scans_completed_total_trg
  after update of scan_completed_at on scans
  for each row execute function bump_scans_completed_total();

-- ── public aggregations ──────────────────────────────────────────────────────
create or replace function public_home_stats()
returns table (resumes_scanned bigint, responses bigint, interviews bigint, first_answer_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select (value ->> 'count')::bigint from system_state where key = 'scans_completed_total'), 0)
      + coalesce((select (value ->> 'offset')::bigint from system_state where key = 'public_stats_adjust'), 0),
    (select count(*) from scan_outcomes where outcome in ('INTERVIEW', 'NO_INTERVIEW')),
    (select count(*) from scan_outcomes where outcome = 'INTERVIEW'),
    (select min(answered_at) from scan_outcomes where outcome in ('INTERVIEW', 'NO_INTERVIEW'));
$$;

-- Interviews reported per field in the last p_days, against the p_days before that. A field with
-- fewer than p_min reports in the current window is not returned at all.
create or replace function public_hot_categories(p_days int, p_min int)
returns table (role_category text, interviews bigint, prev_interviews bigint)
language sql
stable
security definer
set search_path = public
as $$
  select o.role_category,
         (count(*) filter (where o.answered_at >= now() - make_interval(days => p_days)))::bigint as interviews,
         (count(*) filter (where o.answered_at <  now() - make_interval(days => p_days)))::bigint as prev_interviews
  from scan_outcomes o
  where o.outcome = 'INTERVIEW'
    and o.role_category is not null
    and o.answered_at >= now() - make_interval(days => p_days * 2)
  group by o.role_category
  having count(*) filter (where o.answered_at >= now() - make_interval(days => p_days)) >= greatest(p_min, 1)
  order by 2 desc, 1 asc
  limit 12;
$$;

revoke execute on function public_home_stats()              from public, anon, authenticated;
revoke execute on function public_hot_categories(int, int)  from public, anon, authenticated;
revoke execute on function bump_scans_completed_total()     from public, anon, authenticated;
grant  execute on function public_home_stats()              to service_role;
grant  execute on function public_hot_categories(int, int)  to service_role;

create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_email text;
begin
  select email into v_old_email from users where id = p_user_id;

  update scans set
    resume_path                  = null,
    resume_ats_path               = null,
    resume_pdf_path                = null,
    resume_original_name           = null,
    resume_hash                    = null,
    resume_pdf_hash                = null,
    resume_hash_history            = '[]'::jsonb,
    job_description_text           = null,
    job_description_url            = null,
    job_title                      = null,
    candidate_first_name           = null,
    cover_letter_text              = null,
    raw_brain_dump_text            = null,
    original_resume_data           = null,
    rewritten_resume_data          = null,
    quantification_prompts         = null,
    user_edited_resume_data        = null,
    fix_ats_report                 = null,
    full_ats_report                = null,
    verification_code              = null,
    verification_url               = null,
    verify_expose_docx             = false,
    verify_expose_pdf              = false,
    verify_hide_name                = false,
    verification_status             = 'ACTIVE',
    verification_revoked_at         = null,
    verification_revoked_reason     = null,
    fix_payment_id                  = null,
    contact_name                    = null,
    contact_email                   = null
  where user_id = p_user_id;

  -- Homepage outcomes (0070): the story is personal text and the credential link points at a page this
  -- same function just disabled, so both go. The outcome ANSWER itself stays, anonymised (the user row
  -- is soft-deleted; nothing below identifies a person), so the published interview rate does not
  -- shrink when someone leaves.
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false
  where user_id = p_user_id;

  update payments set
    paystack_auth_code = null
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link,
  -- captured above before the users row below overwrites it.
  if v_old_email is not null then
    update email_logs set "to" = 'deleted-' || p_user_id || '@passthrough.dev'
    where "to" = v_old_email;
  end if;

  -- Auth sessions (0047) carry the sign-in IP and user-agent, so they are
  -- personal data: remove them with the account rather than leave them
  -- attached to a soft-deleted users row.
  delete from user_sessions where user_id = p_user_id;

  -- Additional saved profiles (0067) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

  update users set
    deleted_at              = now(),
    email                    = 'deleted-' || p_user_id || '@passthrough.dev',
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    token_version            = token_version + 1,
    reset_token              = null,
    reset_token_expiry       = null,
    email_verify_token       = null,
    email_verify_expiry      = null,
    paystack_customer_code   = null,
    paystack_auth_code       = null,
    pending_email            = null,
    pending_email_token      = null,
    pending_email_expiry     = null,
    last_login_at            = null,
    last_login_ip            = null,
    previous_login_at        = null,
    previous_login_ip        = null,
    last_login_alert_at      = null,
    email_change_done_token  = null
  where id = p_user_id;
end;
$$;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 70, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
