// NEW FILE — not in the v8 spec or the migration patch's table, but required
// by the Supabase swap: Postgres convention is snake_case columns, but the
// entire frontend (built against the v8 API contract) expects camelCase
// fields (emailVerified, scansToday, atsScore, etc.). Rather than touch any
// frontend code, every DB row is mapped to camelCase at the boundary —
// immediately after a Supabase read, before the row reaches a controller.

function userRowToCamel(row) {
  if (!row) return row
  return {
    id:                    row.id,
    email:                 row.email,
    passwordHash:          row.password_hash,
    name:                  row.name,
    role:                  row.role,
    status:                row.status,
    tokenVersion:          row.token_version,
    emailVerified:         row.email_verified,
    emailVerifyToken:      row.email_verify_token,
    emailVerifyExpiry:     row.email_verify_expiry,
    resetToken:            row.reset_token,
    resetTokenExpiry:      row.reset_token_expiry,
    pendingEmail:          row.pending_email ?? null,
    pendingEmailToken:     row.pending_email_token ?? null,
    pendingEmailExpiry:    row.pending_email_expiry ?? null,
    deletedAt:             row.deleted_at,
    scansToday:            row.scans_today,
    freeFixCredits:        row.free_fix_credits,
    scansDayReset:         row.scans_day_reset,
    paystackCustomerCode:  row.paystack_customer_code,
    paystackAuthCode:      row.paystack_auth_code,
    savedProfile:          row.saved_profile,
    // FIX (Section 9/10 audit, feature gap): terms_accepted_at/terms_version
    // (migration 0038) are written at registration (auth.controller.js) but
    // were never read back anywhere — this mapper is the one read path every
    // user-row consumer goes through (getMe, admin), so omitting them meant
    // there was no way, anywhere in the app, to see whether/when/which
    // version of the Terms an account accepted. NULL for any account created
    // before 0038 shipped — that's correct, not a bug (see that migration).
    termsAcceptedAt:       row.terms_accepted_at ?? null,
    termsVersion:          row.terms_version ?? null,
    // FEATURE (Auth section, feature-gap-closing pass — migration 0040):
    // last_login_*/previous_login_* let auth.controller.js's login() decide
    // whether a sign-in looks like a new network (comparing the incoming
    // request's IP against lastLoginIp, read BEFORE this login overwrites
    // it) and give Settings something real to show ("your previous sign-in
    // was..."). lastLoginAlertAt is bookkeeping only — see safeUser() below,
    // which strips it before anything reaches the frontend.
    lastLoginAt:           row.last_login_at ?? null,
    lastLoginIp:           row.last_login_ip ?? null,
    previousLoginAt:       row.previous_login_at ?? null,
    previousLoginIp:       row.previous_login_ip ?? null,
    lastLoginAlertAt:      row.last_login_alert_at ?? null,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at
  }
}

function scanRowToCamel(row) {
  if (!row) return row
  return {
    id:                  row.id,
    status:              row.status,
    resumePath:          row.resume_path,
    resumeOriginalName:  row.resume_original_name,
    resumeMimeType:      row.resume_mime_type,
    jobDescriptionText:  row.job_description_text,
    jobDescriptionUrl:   row.job_description_url,
    atsScore:            row.ats_score,
    fixAtsScore:         row.fix_ats_score,
    // AUDIT FIX (feature gap — Scan/ATS section audit, round 2): see
    // migration 0027 — surfaces whether the last generateFix delivery was a
    // total rewrite failure (original resume delivered unchanged) so
    // getScan/ScanResult.jsx can tell the user honestly rather than showing
    // the normal "below threshold" copy for a scan that was never rewritten
    // at all.
    rewriteFailed:       row.rewrite_failed ?? false,
    fixRetryCount:       row.fix_retry_count,
    // AUDIT FIX (Section 9/10 pass): fix_error_recoveries (migration 0026,
    // claim_errored_fix RPC) was missing here despite being selected via
    // `select('*')` on nearly every call site in scan.controller.js — the
    // same latent-drop pattern as rewriteFailed/freeFixCredits elsewhere in
    // this file, just not yet flagged for this column. Not live today (the
    // only writer is the claim_errored_fix RPC, called directly, never
    // through this mapper) but any future read path expecting it back from
    // scanRowToCamel would have silently gotten undefined.
    fixErrorRecoveries: row.fix_error_recoveries ?? 0,
    passed:              row.passed,
    keywordScore:        row.keyword_score,
    formatScore:         row.format_score,
    sectionsScore:       row.sections_score,
    contentScore:        row.content_score,
    fullAtsReport:       row.full_ats_report,
    scanCompletedAt:     row.scan_completed_at,
    candidateFirstName:  row.candidate_first_name,
    // AUDIT FIX (Section 9/10 pass, live bug): job_title (migration 0035,
    // src/lib/jobTitle.js) was missing here despite scanRowToCamel being the
    // read path for getScan and every other single-scan controller
    // function — unlike the other "latent, no current caller" gaps this
    // file's comments flag elsewhere, this one is live: frontend/src/lib/
    // scanDisplay.js reads scan.jobTitle directly to decide what to show on
    // the scan detail view, and every call site got undefined instead,
    // silently falling through to the role/source fallback every single
    // time. The list view (scan.controller.js's own hand-rolled search/
    // history mapping) was unaffected — it never went through this
    // function — which is why this had shipped without failing anything
    // that exercises the list.
    jobTitle:            row.job_title ?? null,
    fixPurchased:        row.fix_purchased,
    fixTier:             row.fix_tier,
    resumeAtsPath:       row.resume_ats_path,
    resumePdfPath:       row.resume_pdf_path,
    fixGeneratedAt:      row.fix_generated_at,
    coverLetterText:     row.cover_letter_text,
    verificationCode:    row.verification_code,
    verificationUrl:     row.verification_url,
    verifyExposeDocx:    row.verify_expose_docx,
    verifyExposePdf:     row.verify_expose_pdf,
    // Section 7 audit (migration 0025)
    verifyHideName:      row.verify_hide_name,
    verificationStatus:  row.verification_status,
    verificationRevokedAt:     row.verification_revoked_at,
    verificationRevokedReason: row.verification_revoked_reason,
    resumePdfHash:       row.resume_pdf_hash,
    resumeHashHistory:   row.resume_hash_history,
    fixPaymentId:        row.fix_payment_id,
    verificationViews:   row.verification_views,
    resumeHash:          row.resume_hash,
    verifiedAt:          row.verified_at,
    roleCategory:        row.role_category,
    seniorityLevel:      row.seniority_level,
    integrityScore:      row.integrity_score,
    userId:              row.user_id,
    anonToken:           row.anon_token,
    anonExpiresAt:       row.anon_expires_at,
    // Section audit ("generate a resume from scratch"): populated only for
    // anonymous brain-dump submissions — see createScan / migration 0019.
    contactName:            row.contact_name,
    contactEmail:           row.contact_email,
    inputMode:              row.input_mode,
    rawBrainDumpText:       row.raw_brain_dump_text,
    originalResumeData:     row.original_resume_data,
    rewrittenResumeData:    row.rewritten_resume_data,
    quantificationPrompts:  row.quantification_prompts,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at
  }
}

function paymentRowToCamel(row) {
  if (!row) return row
  return {
    id:                  row.id,
    amountCents:         row.amount_cents,
    currency:            row.currency,
    status:              row.status,
    paystackRef:         row.paystack_ref,
    paystackAccessCode:  row.paystack_access_code,
    paystackAuthCode:    row.paystack_auth_code,
    userId:              row.user_id,
    scanId:              row.scan_id,
    // AUDIT FIX (Section 9): fix_tier (added in migration 0010, specifically
    // so fulfillment could trust one column instead of a client-supplied
    // value) was missing here — every current caller happens to select
    // fix_tier directly off the raw row instead of going through this
    // mapper, so this was latent rather than live, but any future caller of
    // paymentRowToCamel (e.g. a payment-history view) would have silently
    // lost it. Same for referral_code/referral_code_id (0012) — added for
    // the same reason: this mapper should reflect the full row, not a
    // snapshot of it frozen at whichever migration last touched this file.
    fixTier:             row.fix_tier,
    referralCodeId:      row.referral_code_id,
    referralCode:        row.referral_code,
    // AUDIT FIX (Section 9/10 pass): refunded_at/refund_reference/disputed_at
    // (migrations 0024/0025) were missing here, same latent-drop shape as
    // fix_tier/referral_code above — no current caller of paymentRowToCamel
    // needed them yet, but adminListPayments (admin.controller.js) is about
    // to become one, and a mapper that silently omits a payment's refund/
    // dispute state is exactly the kind of gap that stays invisible until
    // someone builds the view that needed it.
    refundedAt:          row.refunded_at,
    refundReference:     row.refund_reference,
    disputedAt:          row.disputed_at,
    // AUDIT FIX (Section 9/10 pass): receipt_sent_at (migration 0033) and
    // last_reconciled_at/receipt_delivered_at (migration 0036) were missing
    // here — same latent-drop shape as refunded_at/refund_reference/
    // disputed_at above, but this one wasn't just latent: adminListPayments
    // (admin.controller.js) hand-rolls its own select/field list rather
    // than going through this mapper, and it had ALSO never picked these
    // up, so there was genuinely no way — anywhere in the admin panel or
    // any API response — to see whether a payment's receipt had actually
    // been emailed. receiptSentAt is claimed BEFORE sending (see
    // fulfillment.service.js) so a task cancelled mid-send can leave it set
    // with no email actually delivered; receiptDeliveredAt is the one that
    // answers "did the customer get it" and is what adminListPayments now
    // surfaces (see that function).
    receiptSentAt:       row.receipt_sent_at,
    receiptDeliveredAt:  row.receipt_delivered_at,
    lastReconciledAt:    row.last_reconciled_at,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at
  }
}

// Reverse direction: camelCase JS object -> snake_case DB row, for writes.
// Only includes keys that are present in `obj` (partial updates safe).
function camelToSnake(obj, fieldMap) {
  const out = {}
  for (const [camel, snake] of Object.entries(fieldMap)) {
    if (Object.prototype.hasOwnProperty.call(obj, camel)) out[snake] = obj[camel]
  }
  return out
}

const USER_FIELD_MAP = {
  email: 'email', passwordHash: 'password_hash', name: 'name', role: 'role',
  status: 'status', tokenVersion: 'token_version', emailVerified: 'email_verified',
  emailVerifyToken: 'email_verify_token', emailVerifyExpiry: 'email_verify_expiry',
  resetToken: 'reset_token', resetTokenExpiry: 'reset_token_expiry', deletedAt: 'deleted_at',
  scansToday: 'scans_today', scansDayReset: 'scans_day_reset',
  // AUDIT FIX (Section 9): freeFixCredits (users.free_fix_credits, added in
  // migration 0005) was missing from this reverse map. Currently harmless —
  // the only writer of this column is the increment_free_fix_credits/
  // redeem_free_fix_credit RPCs, never a camelToSnake(USER_FIELD_MAP)
  // update — but any future direct-update code path for it would have
  // silently no-opped, since camelToSnake only emits keys present in the
  // map.
  freeFixCredits: 'free_fix_credits',
  paystackCustomerCode: 'paystack_customer_code', paystackAuthCode: 'paystack_auth_code',
  savedProfile: 'saved_profile',
  // AUDIT FIX (Section 9/10 pass): same latent-drop trap as freeFixCredits
  // above, for pending_email/pending_email_token/pending_email_expiry
  // (migration 0029, auth.controller.js's updateEmail/confirmEmailChange
  // pending-email flow). The only current writers build raw snake_case
  // update objects, so this was harmless today — but a future caller using
  // camelToSnake(USER_FIELD_MAP) to update any of these three would have
  // silently no-opped exactly like the freeFixCredits case did.
  pendingEmail: 'pending_email', pendingEmailToken: 'pending_email_token',
  pendingEmailExpiry: 'pending_email_expiry',
  // FIX (Section 9/10 audit): same read-side gap as userRowToCamel above —
  // no current writer needs this (registration builds a raw snake_case
  // insert), but the reverse map should reflect the full row like every
  // other field here, not silently no-op a future admin-correction write.
  termsAcceptedAt: 'terms_accepted_at', termsVersion: 'terms_version',
  // FIX (Auth section, feature-gap-closing pass): same completeness
  // discipline as termsAcceptedAt/pendingEmail above — no current writer
  // needs this via camelToSnake(USER_FIELD_MAP) (auth.controller.js builds
  // raw snake_case update objects for all five), but the reverse map should
  // mirror the full row, not silently no-op a future caller.
  lastLoginAt: 'last_login_at', lastLoginIp: 'last_login_ip',
  previousLoginAt: 'previous_login_at', previousLoginIp: 'previous_login_ip',
  lastLoginAlertAt: 'last_login_alert_at'
}

const SCAN_FIELD_MAP = {
  status: 'status', resumePath: 'resume_path', resumeOriginalName: 'resume_original_name',
  resumeMimeType: 'resume_mime_type', jobDescriptionText: 'job_description_text',
  jobDescriptionUrl: 'job_description_url', atsScore: 'ats_score', fixAtsScore: 'fix_ats_score', fixRetryCount: 'fix_retry_count', passed: 'passed',
  keywordScore: 'keyword_score', formatScore: 'format_score', sectionsScore: 'sections_score',
  contentScore: 'content_score', fullAtsReport: 'full_ats_report', scanCompletedAt: 'scan_completed_at',
  candidateFirstName: 'candidate_first_name', fixPurchased: 'fix_purchased', fixTier: 'fix_tier',
  resumeAtsPath: 'resume_ats_path', resumePdfPath: 'resume_pdf_path', fixGeneratedAt: 'fix_generated_at',
  coverLetterText: 'cover_letter_text', verificationCode: 'verification_code',
  verificationUrl: 'verification_url', verificationViews: 'verification_views',
  verifyExposeDocx: 'verify_expose_docx', verifyExposePdf: 'verify_expose_pdf',
  resumeHash: 'resume_hash', verifiedAt: 'verified_at',
  verifyHideName: 'verify_hide_name', verificationStatus: 'verification_status',
  verificationRevokedAt: 'verification_revoked_at', verificationRevokedReason: 'verification_revoked_reason',
  resumePdfHash: 'resume_pdf_hash', resumeHashHistory: 'resume_hash_history', fixPaymentId: 'fix_payment_id', roleCategory: 'role_category',
  seniorityLevel: 'seniority_level', integrityScore: 'integrity_score', userId: 'user_id',
  anonToken: 'anon_token', anonExpiresAt: 'anon_expires_at',
  contactName: 'contact_name', contactEmail: 'contact_email',
  inputMode: 'input_mode', rawBrainDumpText: 'raw_brain_dump_text',
  originalResumeData: 'original_resume_data', rewrittenResumeData: 'rewritten_resume_data',
  quantificationPrompts: 'quantification_prompts',
  // AUDIT FIX (Section 9/10 pass): rewrite_failed (migration 0027) was
  // missing here. Not live today — scan.controller.js's one writer builds a
  // raw snake_case update object rather than going through
  // camelToSnake(SCAN_FIELD_MAP) — but the same latent-drop trap as every
  // other entry above marked AUDIT FIX: any future caller that updates a
  // scan via this map would silently no-op a rewriteFailed write.
  rewriteFailed: 'rewrite_failed',
  // AUDIT FIX (Section 9/10 pass): fix_error_recoveries (migration 0026) —
  // same reasoning, matching the scanRowToCamel fix above. The only current
  // writer is the claim_errored_fix RPC, called directly, never through
  // this map.
  fixErrorRecoveries: 'fix_error_recoveries',
  // AUDIT FIX (Section 9/10 pass): jobTitle (migration 0035) had no reverse-
  // map entry either — scan.controller.js's one writer (createScan) builds
  // a raw snake_case insert object rather than going through
  // camelToSnake(SCAN_FIELD_MAP), so this half was latent, not live, unlike
  // the scanRowToCamel read-side gap fixed above.
  jobTitle: 'job_title'
}

const PAYMENT_FIELD_MAP = {
  amountCents: 'amount_cents', currency: 'currency', status: 'status',
  paystackRef: 'paystack_ref', paystackAccessCode: 'paystack_access_code',
  paystackAuthCode: 'paystack_auth_code', userId: 'user_id', scanId: 'scan_id',
  fixTier: 'fix_tier', referralCodeId: 'referral_code_id', referralCode: 'referral_code',
  // AUDIT FIX (Section 9/10 pass): same gap as paymentRowToCamel above —
  // refunded_at/refund_reference/disputed_at (0024/0025) had no reverse-map
  // entry either. webhooks.controller.js and payments.controller.js write
  // these today via raw snake_case updates, so this was latent, not live.
  refundedAt: 'refunded_at', refundReference: 'refund_reference', disputedAt: 'disputed_at',
  // AUDIT FIX (Section 9/10 pass): same gap as paymentRowToCamel above —
  // receipt_sent_at/receipt_delivered_at/last_reconciled_at (0033/0036) had
  // no reverse-map entry either. fulfillment.service.js and
  // reconcile.service.js write these today via raw snake_case updates, so
  // this half was latent, not live.
  receiptSentAt: 'receipt_sent_at', receiptDeliveredAt: 'receipt_delivered_at',
  lastReconciledAt: 'last_reconciled_at'
}

// AUDIT FIX (Section 10 build-out): needed for the new admin
// set-commission-rate / pause-partner endpoints in partners.controller.js —
// previously there was no reverse map for partners at all, so those writes
// had to go around camelToSnake with hand-built snake_case objects like the
// rest of this controller already does elsewhere. Only the two fields that
// are actually meant to be admin-editable after creation are included here
// deliberately — payout_details_token, referral_code, email etc. all have
// their own dedicated, more careful write paths elsewhere in
// partners.controller.js and should not become reachable through a generic
// partial-update helper.
const PARTNER_FIELD_MAP = {
  status: 'status', commissionRate: 'commission_rate'
}

// partners/payouts (see supabase/migrations/0011_partners_and_payouts.sql).
// payout_details_token is intentionally NEVER included in THIS mapper — it's
// a bearer secret (whoever has it can view/edit that partner's payout
// details), so it must never round-trip through a general partner-read
// response (adminListPartners, adminGetPartner, etc.). The only places it's
// ever read are directly off the DB row inside partners.controller.js,
// right before being embedded in the emailed link — and, as a narrow,
// deliberate exception (AUDIT FIX, feature gap: no admin fallback if the
// email itself fails to deliver), echoed back as `payoutUrl` in the JSON
// response of the two admin actions that just (re)issued it,
// adminResendPayoutLink and adminRegeneratePayoutLink — never from here.
function partnerRowToCamel(row) {
  if (!row) return row
  const { payout_details_token, ...rest } = row
  return {
    id:                        rest.id,
    name:                      rest.name,
    email:                     rest.email,
    referralCode:              rest.referral_code,
    status:                    rest.status,
    // AUDIT FIX (Section 10): PostgREST serializes Postgres `numeric`
    // columns as JSON strings (to avoid float precision loss), so this came
    // through as e.g. "0.2500" rather than 0.25 — the one column in this
    // whole schema still using `numeric` instead of int cents, and the one
    // place that convention's absence actually leaked into an API response.
    // referral.service.js already does this same Number() conversion
    // before using the value in arithmetic; this just makes the read side
    // consistent with that.
    commissionRate:            rest.commission_rate == null ? null : Number(rest.commission_rate),
    payoutMethod:              rest.payout_method,
    payoutDetails:             rest.payout_details,
    payoutDetailsSubmittedAt:  rest.payout_details_submitted_at,
    payouts:                   rest.payouts ? rest.payouts.map(payoutRowToCamel) : undefined,
    referralCodes:             rest.referral_codes ? rest.referral_codes.map(referralCodeRowToCamel) : undefined,
    commissionLedger:          rest.commission_ledger ? rest.commission_ledger.map(commissionLedgerRowToCamel) : undefined,
    createdAt:                 rest.created_at,
    updatedAt:                 rest.updated_at
  }
}

function payoutRowToCamel(row) {
  if (!row) return row
  return {
    id:                    row.id,
    partnerId:             row.partner_id,
    amountCents:           row.amount_cents,
    currency:              row.currency,
    payoutMethod:          row.payout_method,
    payoutDetailsSnapshot: row.payout_details_snapshot,
    note:                  row.note,
    status:                row.status,
    // AUDIT FIX (Admin panel — twice-monthly payout cycles): added by
    // migration 0016 (payouts.period_start/period_end) so a recorded
    // payout remembers which cycle it settled, if any — null for an ad hoc
    // payout (a bonus, a catch-up covering multiple stale cycles) that
    // wasn't scoped to one specific cycle. See lib/cycles.js.
    periodStart:           row.period_start,
    periodEnd:             row.period_end,
    paidAt:                row.paid_at,
    createdAt:             row.created_at
  }
}

function referralCodeRowToCamel(row) {
  if (!row) return row
  return {
    id:          row.id,
    partnerId:   row.partner_id,
    code:        row.code,
    tierPrices:  row.tier_prices,
    active:      row.active,
    usageLimit:  row.usage_limit,
    usesSoFar:   row.uses_so_far,
    clicks:      row.clicks,
    expiresAt:   row.expires_at,
    createdAt:   row.created_at
  }
}

function commissionLedgerRowToCamel(row) {
  if (!row) return row
  return {
    id:                    row.id,
    paymentId:             row.payment_id,
    partnerId:             row.partner_id,
    referralCodeId:        row.referral_code_id,
    grossAmountCents:      row.gross_amount_cents,
    // AUDIT FIX (Section 10): same numeric-as-string gotcha as partnerRowToCamel above.
    commissionRate:        row.commission_rate == null ? null : Number(row.commission_rate),
    commissionAmountCents: row.commission_amount_cents,
    payoutId:              row.payout_id,
    // Section 8 audit: a reversal is a NEGATIVE row pointing at the row it undoes.
    reversesLedgerId:      row.reverses_ledger_id ?? null,
    reversalReason:        row.reversal_reason ?? null,
    createdAt:             row.created_at
  }
}

function leadRowToCamel(row) {
  if (!row) return row
  return {
    id:           row.id,
    name:         row.name,
    company:      row.company,
    email:        row.email,
    roleCategory: row.role_category,
    roleTitle:    row.role_title ?? null,
    source:       row.source,
    sourceCode:   row.source_code ?? null,
    status:       row.status,
    notes:        row.notes,
    submissionCount: row.submission_count ?? 1,
    lastSubmittedAt: row.last_submitted_at ?? row.created_at,
    contactedAt:  row.contacted_at ?? null,
    confirmedAt:  row.confirmed_at ?? null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at
  }
}

module.exports = {
  userRowToCamel, scanRowToCamel, paymentRowToCamel, camelToSnake,
  partnerRowToCamel, payoutRowToCamel, referralCodeRowToCamel, commissionLedgerRowToCamel,
  leadRowToCamel,
  USER_FIELD_MAP, SCAN_FIELD_MAP, PAYMENT_FIELD_MAP, PARTNER_FIELD_MAP
}
