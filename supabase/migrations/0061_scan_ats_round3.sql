-- Scan / ATS round 3.
--
-- user_edited_resume_data (B2, G7): the resume the OWNER saved from the delivered-resume editor.
--   * It is the fabrication baseline for "Try Again": the owner vouches for their own figures and
--     skills, so a retry that keeps them is not flagged as invented (before this, a retry after
--     adding a real metric was rejected on every attempt - the guard only knew the original upload).
--   * It is also how the UI tells "you changed this" apart from "the AI changed this".
-- fix_ats_report (G3): the score breakdown (same shape as full_ats_report) of the DELIVERED
--   document, so a below-threshold result can show what is still missing instead of the original
--   scan's stale gaps.
--
-- Both hold resume content, so scrub_account_data (0047) is redefined to clear them too.
-- `create or replace` keeps the EXECUTE grants 0023/0047 set on it.

alter table scans add column if not exists user_edited_resume_data jsonb;
alter table scans add column if not exists fix_ats_report          jsonb;

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
values ('schema_version', jsonb_build_object('version', 61, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
