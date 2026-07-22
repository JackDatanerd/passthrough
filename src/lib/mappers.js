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
    deletedAt:             row.deleted_at,
    scansToday:            row.scans_today,
    scansDayReset:         row.scans_day_reset,
    paystackCustomerCode:  row.paystack_customer_code,
    paystackAuthCode:      row.paystack_auth_code,
    savedProfile:          row.saved_profile,
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
    passed:              row.passed,
    keywordScore:        row.keyword_score,
    formatScore:         row.format_score,
    sectionsScore:       row.sections_score,
    contentScore:        row.content_score,
    fullAtsReport:       row.full_ats_report,
    scanCompletedAt:     row.scan_completed_at,
    candidateFirstName:  row.candidate_first_name,
    fixPurchased:        row.fix_purchased,
    fixTier:             row.fix_tier,
    resumeAtsPath:       row.resume_ats_path,
    resumePdfPath:       row.resume_pdf_path,
    fixGeneratedAt:      row.fix_generated_at,
    coverLetterText:     row.cover_letter_text,
    verificationCode:    row.verification_code,
    verificationUrl:     row.verification_url,
    verificationViews:   row.verification_views,
    resumeHash:          row.resume_hash,
    verifiedAt:          row.verified_at,
    roleCategory:        row.role_category,
    seniorityLevel:      row.seniority_level,
    integrityScore:      row.integrity_score,
    userId:              row.user_id,
    anonToken:           row.anon_token,
    anonExpiresAt:       row.anon_expires_at,
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
  paystackCustomerCode: 'paystack_customer_code', paystackAuthCode: 'paystack_auth_code',
  savedProfile: 'saved_profile'
}

const SCAN_FIELD_MAP = {
  status: 'status', resumePath: 'resume_path', resumeOriginalName: 'resume_original_name',
  resumeMimeType: 'resume_mime_type', jobDescriptionText: 'job_description_text',
  jobDescriptionUrl: 'job_description_url', atsScore: 'ats_score', fixAtsScore: 'fix_ats_score', passed: 'passed',
  keywordScore: 'keyword_score', formatScore: 'format_score', sectionsScore: 'sections_score',
  contentScore: 'content_score', fullAtsReport: 'full_ats_report', scanCompletedAt: 'scan_completed_at',
  candidateFirstName: 'candidate_first_name', fixPurchased: 'fix_purchased', fixTier: 'fix_tier',
  resumeAtsPath: 'resume_ats_path', resumePdfPath: 'resume_pdf_path', fixGeneratedAt: 'fix_generated_at',
  coverLetterText: 'cover_letter_text', verificationCode: 'verification_code',
  verificationUrl: 'verification_url', verificationViews: 'verification_views',
  resumeHash: 'resume_hash', verifiedAt: 'verified_at', roleCategory: 'role_category',
  seniorityLevel: 'seniority_level', integrityScore: 'integrity_score', userId: 'user_id',
  anonToken: 'anon_token', anonExpiresAt: 'anon_expires_at',
  inputMode: 'input_mode', rawBrainDumpText: 'raw_brain_dump_text',
  originalResumeData: 'original_resume_data', rewrittenResumeData: 'rewritten_resume_data',
  quantificationPrompts: 'quantification_prompts'
}

const PAYMENT_FIELD_MAP = {
  amountCents: 'amount_cents', currency: 'currency', status: 'status',
  paystackRef: 'paystack_ref', paystackAccessCode: 'paystack_access_code',
  paystackAuthCode: 'paystack_auth_code', userId: 'user_id', scanId: 'scan_id'
}

module.exports = {
  userRowToCamel, scanRowToCamel, paymentRowToCamel, camelToSnake,
  USER_FIELD_MAP, SCAN_FIELD_MAP, PAYMENT_FIELD_MAP
}
