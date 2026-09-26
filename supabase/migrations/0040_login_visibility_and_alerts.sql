-- 0040_login_visibility_and_alerts.sql
-- Auth section, feature-gap-closing pass. Idempotent — safe to re-run.
--
-- Closes the gap the Auth audit flagged: a failed-login lockout gets the
-- account owner an email (account_lockout_alert, 0022+/rateLimiter.js), but a
-- SUCCESSFUL sign-in — the one that actually matters if a password leaked —
-- left no trace anywhere the owner could see. There was also no way for the
-- owner to know whether "Sign out other sessions" (Settings) was something
-- they had any reason to click.
--
-- Deliberately NOT a session/device table: this app's tokens are a single
-- global token_version counter, not per-session JWTs, so there is nothing
-- today that could enumerate or individually revoke "sessions" — building
-- that is a real re-architecture (moving to per-token jti + a lookup on every
-- authenticated request), not a small addition to this table, and is out of
-- scope for this pass. What IS in scope and genuinely useful without that:
--   - last_login_at / last_login_ip:      this session's own sign-in.
--   - previous_login_at / previous_login_ip: the one before it — captured by
--     shifting last_* into previous_* at the START of the NEXT login, before
--     overwriting last_*. This is the pair actually worth showing someone:
--     "last_login_at" always reads "just now" once you're looking at it, so
--     it's "previous" that answers "does that match what you did?".
--   - last_login_alert_at: bookkeeping only (not shown to the user) so the
--     "new sign-in" email (see auth.controller.js's recordLoginMetadata) can
--     be throttled to at most one per NEW_LOGIN_ALERT_THROTTLE_HOURS — a
--     phone hopping cell towers changes IP on nearly every reconnect, and
--     alerting on every single one trains the account owner to ignore the
--     one that eventually matters.
--
-- No user agent column: it would only ever be dead weight (PII collected and
-- kept, but never actually shown to anyone or used for anything) unless a
-- device/session table gets built later to make use of it — better to add it
-- then, alongside whatever that table actually needs, than store it unused
-- now.

alter table users add column if not exists last_login_at         timestamptz;
alter table users add column if not exists last_login_ip         text;
alter table users add column if not exists previous_login_at     timestamptz;
alter table users add column if not exists previous_login_ip     text;
alter table users add column if not exists last_login_alert_at   timestamptz;

-- scrub_account_data: the SIXTH create-or-replace of this function (0022 ->
-- 0025 -> 0026 -> 0029 -> 0035 -> this). It is 0035's body, unchanged, plus
-- the five columns above nulled — an IP address and the timestamps of when
-- someone signed in are exactly the kind of thing "all associated data
-- deleted" has to actually mean. Built on 0035 rather than an earlier
-- version on purpose: a replace that starts from an older body silently
-- drops every column added since (that is exactly how 0026 regressed 0025).
-- CREATE OR REPLACE keeps the function's OID, so the EXECUTE grant 0023 gave
-- to service_role needs no re-grant.

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

  update payments set
    paystack_auth_code = null
  where user_id = p_user_id;

  -- email_logs has no user_id column — "to" (the address) is the only link,
  -- captured above before the users row below overwrites it.
  if v_old_email is not null then
    update email_logs set "to" = 'deleted-' || p_user_id || '@passthrough.dev'
    where "to" = v_old_email;
  end if;

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
    last_login_alert_at      = null
  where id = p_user_id;
end;
$$;
