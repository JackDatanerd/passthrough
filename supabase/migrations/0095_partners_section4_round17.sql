-- Partners / Referral program, section 4 round 17.
--
-- 1. users.referred_sub. The partner's channel tag (`&sub=`, migration 0093) travelled browser -> payment -> ledger, but unlike
--    the code it was never kept on the ACCOUNT, so a tagged click on one device (or after clearing site data) was bought
--    untagged on another: "Sales by channel" understated the tagged channels. The tag now rides next to referred_by_code /
--    referred_at (0076). Same format as payments.referral_sub: lower-case letters, digits, `_`, `-`, 1-32 characters.
--    Additive and idempotent.
-- 2. scrub_account_data (the ELEVENTH definition; 0082's body is the base, nothing it covered is dropped): the one change is
--    that referred_sub is cleared with the other attribution columns when an account is deleted.

alter table users add column if not exists referred_sub text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_referred_sub_check') then
    alter table users add constraint users_referred_sub_check
      check (referred_sub is null or referred_sub ~ '^[a-z0-9_-]{1,32}$');
  end if;
end $$;

-- ── 2. scrub_account_data ────────────────────────────────────────────────────

create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_email     text;
  v_pending_email text;
  v_placeholder   text := 'deleted-' || p_user_id || '@passthrough.dev';
  r               record;
begin
  select email, pending_email into v_old_email, v_pending_email from users where id = p_user_id;

  -- The page links and file fingerprints this account published outlive it as tombstones (0036 / 0049).
  -- Done FIRST, in this same transaction: the columns are nulled below, so a failure after that point can no
  -- longer be recovered from.
  for r in
    select verification_code, resume_hash, resume_pdf_hash, resume_hash_history
      from scans where user_id = p_user_id and verification_code is not null
  loop
    perform write_verification_tombstone(r.verification_code, r.resume_hash, r.resume_pdf_hash, r.resume_hash_history);
  end loop;

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
  -- same function just disabled, so both go. The outcome ANSWER itself stays, anonymised.
  update scan_outcomes set
    story_consent         = false,
    story_status          = 'NONE',
    story_display_name    = null,
    story_quote           = null,
    story_text            = null,
    story_show_credential = false
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link, captured above before the users
  -- row below overwrites it. An unconfirmed pending address was mailed too (the confirmation link).
  if v_old_email is not null then
    update email_logs set "to" = v_placeholder where "to" = v_old_email;
  end if;
  if v_pending_email is not null and v_pending_email is distinct from v_old_email then
    update email_logs set "to" = v_placeholder where "to" = v_pending_email;
  end if;

  -- Auth sessions (0047) carry the sign-in IP and user-agent.
  delete from user_sessions where user_id = p_user_id;

  -- Additional saved profiles (0067) hold the same resume PII as users.saved_profile.
  delete from saved_profiles where user_id = p_user_id;

  update users set
    deleted_at              = coalesce(deleted_at, now()),
    email                    = v_placeholder,
    name                     = 'Deleted User',
    password_hash            = 'deleted',
    saved_profile            = null,
    saved_profile_prev       = null,
    token_version            = token_version + 1,
    reset_token              = null,
    reset_token_expiry       = null,
    email_verify_token       = null,
    email_verify_expiry      = null,
    pending_email            = null,
    pending_email_token      = null,
    pending_email_expiry     = null,
    last_login_at            = null,
    last_login_ip            = null,
    previous_login_at        = null,
    previous_login_ip        = null,
    last_login_alert_at      = null,
    email_change_done_token  = null,
    referred_by_code         = null,
    referred_at              = null,
    referred_sub             = null
  where id = p_user_id;
end;
$$;

-- CREATE OR REPLACE keeps the grants; restated so this file reads on its own.
revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (95, '0095_partners_section4_round17')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 95, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 95;   -- never move the version BACKWARDS (a re-run of an older file)
