-- 0035_scan_job_title_and_scrub.sql
-- Profile & Dashboard (Section 6), fix round. Idempotent — safe to re-run.
--
-- scans.job_title — a short label taken from the pasted job description (see
-- src/lib/jobTitle.js), so the dashboard can tell apart ten rescans of the
-- same resume against ten job descriptions. Until now every brain-dump /
-- saved-profile scan in the list read "Built from scratch" / "From saved
-- profile" plus a date, and every file scan read its filename.
--
-- ORDER OF DEPLOY: run this migration BEFORE deploying the code that ships with
-- it — scan creation and the history list now write/read this column.
--
-- Backfill: the same rule the app applies at scan time, but first LINE only
-- (the app looks at the first few for one that is not a heading). Rows it
-- cannot label stay NULL and the dashboard falls back to the role category.
-- Scans of deleted accounts have no job_description_text (scrubbed) and are
-- untouched.

alter table scans add column if not exists job_title text;

update scans s
   set job_title = t.line
  from (
    select id,
           btrim(regexp_replace((regexp_match(job_description_text, '([^\r\n]*\S[^\r\n]*)'))[1], '\s+', ' ', 'g')) as line
      from scans
     where job_description_text is not null
       and job_title is null
  ) t
 where s.id = t.id
   and length(t.line) between 3 and 100
   and t.line !~* '^(about|job\s*(description|summary|details|overview)|description|overview|company|who we are|we are|we''re|our (mission|team|company)|location|responsibilit|apply|position summary)';

-- scrub_account_data: the FIFTH create-or-replace of this function (0022 -> 0025
-- -> 0026 -> 0029 -> this). It is 0029's body, unchanged, plus job_title = null
-- — what someone applied for is personal, and job_description_text (already
-- nulled here) is where the title came from. Built on 0029 rather than an
-- earlier version on purpose: a replace that starts from an older body silently
-- drops every column added since (that is exactly how 0026 regressed 0025).
-- CREATE OR REPLACE keeps the function's OID, so the EXECUTE grant 0023 gave to
-- service_role needs no re-grant.

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
    pending_email_expiry     = null
  where id = p_user_id;
end;
$$;
