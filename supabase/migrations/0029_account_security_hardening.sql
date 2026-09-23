-- Section 6 fixing-time pass — account settings / profile.
-- Renumbered repeatedly (originally drafted as 0024/0025, then 0026/0027,
-- then 0027/0028) as the live repo kept claiming those numbers for unrelated
-- concurrent work — see 0028's comment for the same history on the
-- employer-leads side.
--
-- Landed alongside (not instead of) two other sessions' own account-settings
-- work in the same window:
--   - An "Auth section round 2" pass added sendPasswordChanged /
--     sendAccountLockoutAlert / sendEmailChangedOldAddress / sendAccountDeleted
--     confirmation emails, and a byte-aware (not character-count) password
--     length check. None of that overlaps what's below; kept as-is.
--   - A Section 9/10 pass's own 0026_scrub_account_data_completeness.sql
--     independently found and fixed two of the same gaps this pass was about
--     to fix in scrub_account_data: scans.contact_name/contact_email (0019)
--     and users.paystack_auth_code/paystack_customer_code were being left
--     behind on account deletion. It went further than this pass had —
--     payments.paystack_auth_code (a SEPARATE reusable payment credential,
--     stored on the payments table, not just users) was also uncleared, and
--     0026 fixed that too.
--
-- BUT: 0026's `create or replace function scrub_account_data` replaces the
-- ENTIRE function body, and it was written against 0022's original column
-- list — not 0025_verify_and_webhook_hardening.sql's later additions
-- (resume_pdf_hash, resume_hash_history, verification_status,
-- verification_revoked_at, verification_revoked_reason, verify_hide_name,
-- fix_payment_id, all added to `scans` by that same 0025). Because 0026 ran
-- after 0025 and doesn't mention those seven columns, IT SILENTLY REGRESSED
-- 0025's OWN scrub coverage: as of 0026, deleting an account leaves a
-- scan's resume hash history, revocation state and fix-payment link
-- pointing at a "deleted" account. This is a genuine bug in the live repo,
-- not a hypothetical — caught only because this pass's own scrub work
-- required reading scrub_account_data's full history to build on it
-- correctly, which surfaced the diff.
--
-- This migration is therefore the FOURTH create-or-replace of this function
-- (0022 -> 0025's audit's 0025 -> 0026 -> this one) and is the union of
-- every column any of the three ever covered, plus what THIS pass adds:
--
-- 1. Pending-email confirmation. updateEmail (auth.controller.js) still
--    flips `email` the instant a correct password is supplied — to any
--    string, including a typo'd address that belongs to someone else, and
--    with no confirmation step on the new address. That address then
--    IMMEDIATELY becomes the account's real login/reset/notification email,
--    and the account is simultaneously flipped to email_verified=false —
--    which blocks paid downloads (downloadFile requires it) until the new
--    (possibly wrong, possibly not even the account owner's) address
--    verifies. The round-2 pass added a notice to the OLD address, which
--    helps a real takeover victim notice — but doesn't stop a genuine typo
--    or a not-yet-malicious mistake from taking effect immediately with no
--    way back. pending_email/pending_email_token/pending_email_expiry let
--    the change sit unconfirmed on the new address while the OLD address
--    keeps working exactly as it did before — nothing about the live
--    account changes until the new address proves it's real and reachable.
--
-- 2. Outstanding reset links survive a password change today. changePassword
--    bumps token_version (invalidating JWTs) but never touched reset_token —
--    a reset link requested by someone who briefly had access to the
--    mailbox stays valid for its full window even after the legitimate
--    owner "secures" the account by changing the password. No schema change
--    needed for this half; the fix is in auth.controller.js clearing the
--    column explicitly.

alter table users add column if not exists pending_email        text;
alter table users add column if not exists pending_email_token  text;
alter table users add column if not exists pending_email_expiry timestamptz;

create unique index if not exists idx_users_pending_email_token
  on users (pending_email_token) where pending_email_token is not null;

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
    pending_email_expiry     = null
  where id = p_user_id;
end;
$$;

-- CREATE OR REPLACE keeps the function's existing OID, so the EXECUTE grant
-- 0023 gave to service_role (and revoked from everyone else) needs no
-- re-grant — same note 0026 made for the same reason.
