-- BUG FIX (Section 6, fixing-time pass): deleteAccount (auth.controller.js)
-- previously ran the scan-content scrub and the user soft-delete as two
-- separate, unrelated UPDATE statements from the application layer — and
-- treated a failure in either one as non-fatal, only console.error'ing it
-- before falling through to the final `users` update regardless. Since
-- `deleted_at` blocks all future login (auth.js), a failed scrub left the
-- account permanently locked while PII (resume text, job description text,
-- candidate's real first name, cover letter text, structured resume data)
-- sat completely unscrubbed in `scans` forever, with no way for the user to
-- ever retry — a request that responded "Account deleted." while silently
-- not deleting the data, contradicting the Settings.jsx confirmation
-- dialog's own promise ("Permanently delete your account and all
-- associated data. This cannot be undone.").
--
-- Wrapping both updates in a single plpgsql function makes them atomic:
-- a plpgsql function body executes inside the transaction of the statement
-- that invoked it, so any error partway through (a constraint violation, a
-- connectivity blip mid-request, anything) rolls back everything the
-- function did, and the RPC call itself returns an error instead of a
-- silently-swallowed one. The controller now surfaces that error as a real
-- 500 and leaves the account exactly as it was, so the user can retry
-- instead of being locked out of a half-finished deletion. R2 file
-- deletion still happens afterward, from the application layer — object
-- storage isn't part of this (or any) Postgres transaction, so that half
-- stays best-effort, but its failures are now logged instead of swallowed
-- (see auth.controller.js).
--
-- Column list and literal values are byte-for-byte the same as the
-- application code this replaces.

create or replace function scrub_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update scans set
    resume_path             = null,
    resume_ats_path         = null,
    resume_pdf_path         = null,
    resume_original_name    = null,
    resume_hash             = null,
    job_description_text    = null,
    job_description_url     = null,
    candidate_first_name    = null,
    cover_letter_text       = null,
    raw_brain_dump_text     = null,
    original_resume_data    = null,
    rewritten_resume_data   = null,
    quantification_prompts  = null,
    full_ats_report         = null,
    verification_code       = null,
    verification_url        = null,
    verify_expose_docx      = false,
    verify_expose_pdf       = false
  where user_id = p_user_id;

  update users set
    deleted_at     = now(),
    email          = 'deleted-' || p_user_id || '@passthrough.dev',
    name           = 'Deleted User',
    password_hash  = 'deleted',
    saved_profile  = null,
    token_version  = token_version + 1
  where id = p_user_id;
end;
$$;
