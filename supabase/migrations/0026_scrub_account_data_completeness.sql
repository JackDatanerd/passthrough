-- AUDIT FIX (Section 9/10 pass — deleteAccount completeness).
--
-- scrub_account_data (migration 0022) made the account-deletion scrub atomic,
-- closing the "half-scrubbed, permanently locked account" bug — but its
-- column list was written before two later additions existed, and so leaves
-- both un-scrubbed on an otherwise-deleted account:
--   * scans.contact_name / scans.contact_email (migration 0019) — collected
--     from an ANONYMOUS brain-dump submitter so runAtsScan could email them a
--     link back to their own scan. Once that scan is claimed into an account
--     (auth.controller.js's claimScan already clears both at claim time — see
--     that function), the only way this pair can still be non-null at
--     deletion time is a scan the user never claimed through the normal flow;
--     deleting the account must not leave typed contact details behind.
--   * payments.paystack_auth_code — a REUSABLE card-authorization token
--     Paystack returns on a successful charge (see webhooks.controller.js /
--     payments.controller.js's verifyPayment, both of which store it). It is
--     never read back by anything in this codebase today, but it is a live
--     payment credential for that card, and "delete my account and all
--     associated data" has to mean it doesn't survive the deletion it was
--     never mentioned as an exception to.
--
-- `create or replace function` keeps the function's existing OID, so the
-- EXECUTE grant 0023 gave to service_role (and revoked from everyone else)
-- is untouched by this replace — no re-grant needed here.

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
    contact_name             = null,
    contact_email            = null,
    verification_code       = null,
    verification_url        = null,
    verify_expose_docx      = false,
    verify_expose_pdf       = false
  where user_id = p_user_id;

  update payments set
    paystack_auth_code = null
  where user_id = p_user_id;

  update users set
    deleted_at     = now(),
    email          = 'deleted-' || p_user_id || '@passthrough.dev',
    name           = 'Deleted User',
    password_hash  = 'deleted',
    saved_profile  = null,
    reset_token           = null,
    reset_token_expiry    = null,
    email_verify_token    = null,
    email_verify_expiry   = null,
    paystack_customer_code = null,
    paystack_auth_code     = null,
    token_version  = token_version + 1
  where id = p_user_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fix_error_recoveries: how many times claim_errored_fix (below) has
-- automatically re-queued this scan after its fix generation failed. Backs
-- both the automatic sweep's per-scan attempt cap and the admin dashboard's
-- ability to show "2 automatic attempts failed" rather than a bare status.
alter table scans add column if not exists fix_error_recoveries int not null default 0;

-- Section 9/10 pass — recovery for a paid scan whose fix generation FAILED.
--
-- Backs reconcile.service.js's sweepFailedFixes and admin.controller.js's
-- adminRequeueFix: an atomic claim so a scan can never be double-enqueued by
-- the automatic sweep and a concurrent manual admin re-run, or by two
-- overlapping sweep executions. p_max lets the automatic sweep enforce its
-- own attempt cap while the admin action (p_max very high) is not bound by it.
create or replace function claim_errored_fix(p_scan_id uuid, p_max int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  update scans set
    status = 'FIX_GENERATING',
    fix_error_recoveries = coalesce(fix_error_recoveries, 0) + 1
  where id = p_scan_id
    and status = 'ERROR'
    and fix_purchased = true
    and coalesce(fix_error_recoveries, 0) < p_max;

  v_claimed := found;
  return v_claimed;
end;
$$;

revoke execute on function claim_errored_fix(uuid, int) from public, anon, authenticated;
grant  execute on function claim_errored_fix(uuid, int) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Undoes exactly what increment_fix_retry_if_available (migration 0009/0015)
-- did, for retryFix's enqueue-failure path (scan.controller.js). That RPC
-- already atomically consumes one retry and flips the scan to FIX_GENERATING
-- BEFORE the job is enqueued; if FIX_QUEUE.send() then throws, nothing will
-- ever generate the fix, and the customer has silently lost a retry for a job
-- that never started. Only reverts a scan this exact call just put into
-- FIX_GENERATING (never one already generating for an unrelated reason), so a
-- late/duplicate revert can't clobber a job that's actually in flight.
create or replace function revert_fix_retry(p_scan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update scans set
    fix_retry_count = greatest(fix_retry_count - 1, 0),
    status = 'FIX_DELIVERED'
  where id = p_scan_id
    and status = 'FIX_GENERATING';
end;
$$;

revoke execute on function revert_fix_retry(uuid) from public, anon, authenticated;
grant  execute on function revert_fix_retry(uuid) to service_role;
