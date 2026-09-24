// Phase 4 — profile reuse. Three endpoints, all auth-required.
//
// SECURITY NOTE on saveProfile: the request body is { scanId }, never raw
// resume data. The server looks up that scan (verifying ownership), reads
// ITS original_resume_data, and copies that into users.saved_profile. This
// is deliberate — accepting arbitrary client-supplied JSON here would let a
// malicious or buggy client inject unvalidated content into saved_profile,
// which later gets rendered into a DOCX/PDF for a completely different scan.
// Routing through an owned scan means the only data that can ever become a
// saved profile is the structured resume the server itself derived from that
// user's own upload or brain dump (original_resume_data) — never a value the
// client typed into this request. (detectFabrication() is NOT part of that
// story: it only compares an original against a rewrite, and a saved profile
// is the original.) Same trust posture as the rest of the app — never trust a
// client-supplied payload where a server-side lookup can derive the same value
// safely (see payments.controller.js's amount calculation for the same
// pattern applied to pricing).

const { getSupabase } = require('../config/supabase')
const { scanRowToCamel } = require('../lib/mappers')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { isRangeError } = require('../lib/db')

// GET /api/profile
// FEATURE GAP CLOSED (Section 6, fixing-time pass): a saved profile used to
// be a total black box — Settings.jsx could show only a save date. There
// was no stored reference to which scan it came from, so a bad or stale
// save could only be fixed by deleting it and starting over from a fresh
// scan. Now returns sourceScanId (so the UI can link back to the original
// scan) plus a small summary pulled from the stored resumeData itself
// (candidate's own name and the role category of the scan it came from) so
// the settings page can show more than just a bare timestamp without
// exposing the full structured resume data over this endpoint.
async function getProfile(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('users').select('saved_profile').eq('id', user.id).single()
  if (error) throw error

  const saved = data.saved_profile
  // Enough to tell what is actually saved without shipping the resume itself
  // (contact details, full history) over this endpoint: who, which field, the
  // most recent title, and how much is in there.
  const rd = saved?.resumeData
  const count = (v) => Array.isArray(v) ? v.length : 0
  const summary = rd ? {
    name:         rd.name || null,
    roleCategory: saved.roleCategory || null,
    latestTitle:  (Array.isArray(rd.experience) && rd.experience[0]?.title) || null,
    jobCount:     count(rd.experience),
    educationCount: count(rd.education),
    skillCount:   count(rd.skills)
  } : null

  return c.json({ success: true, data: {
    hasSavedProfile: !!saved?.resumeData,
    savedAt:         saved?.savedAt || null,
    sourceScanId:    saved?.sourceScanId || null,
    summary
  }})
}

// POST /api/profile/save  { scanId }
async function saveProfile(c) {
  const user = c.get('user')
  // `null`, an array or a bare string are all valid JSON: reading `.scanId`
  // off them used to throw a TypeError and answer 500 for a client mistake.
  let body
  try { body = await c.req.json() } catch (_) { body = null }
  const scanId = body && typeof body === 'object' ? body.scanId : undefined
  if (!scanId) return c.json({ success: false, message: 'scanId required.' }, 400)
  if (typeof scanId !== 'string') return c.json({ success: false, message: 'Invalid scanId.' }, 400)
  // BUG FIX (Section 6, traced cross-cutting to scan.routes.js — see
  // validateUuidParam.js): scanId here is a JSON body field rather than a
  // route param, so the route-level middleware doesn't cover it — same
  // underlying issue (a malformed value reaching `.eq('id', ...)` as an
  // uncaught Postgres error) needs its own inline check.
  if (!UUID_RE.test(scanId)) return c.json({ success: false, message: 'Invalid scanId.' }, 400)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return c.json({ success: false, message: 'Access denied.' }, 403)
  if (!scan.originalResumeData)
    return c.json({ success: false, message: 'This scan has no structured resume data to save yet.' }, 400)

  // Wrapped with savedAt (and now sourceScanId/roleCategory — see
  // getProfile's comment above) inside the single jsonb column — avoids a
  // schema change for what's otherwise a handful of small extra fields.
  const savedProfile = {
    resumeData:   scan.originalResumeData,
    savedAt:      new Date().toISOString(),
    sourceScanId: scan.id,
    roleCategory: scan.roleCategory || null
  }
  const { error: updErr } = await supabase.from('users').update({ saved_profile: savedProfile }).eq('id', user.id)
  if (updErr) throw updErr

  return c.json({ success: true, message: 'Profile saved for reuse.' })
}

// DELETE /api/profile
async function deleteProfile(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { error } = await supabase.from('users').update({ saved_profile: null }).eq('id', user.id)
  if (error) throw error
  return c.json({ success: true, message: 'Saved profile removed.' })
}

// GET /api/profile/export[?part=N] — the account's own data as JSON downloads
// (access / portability). Explicit column lists, camelCased by hand: this is a
// file the user keeps and forwards, so nothing credential-shaped (password
// hash, tokens, Paystack codes, anonymous-scan tokens) may ever ride along by
// accident when a column is added to a table later.
//
// Split into PARTS of EXPORT_SCANS_PER_PART scans. It used to be one file
// capped at the newest 1000 scans, with the only sign of the cut a `truncated`
// flag buried inside the file — an account with more scans silently got an
// incomplete export, and building one response out of thousands of structured
// resumes (each pretty-printed) risks the Worker's memory limit. Part 1 also
// carries the account, saved profile and payments; every part says how many
// parts there are (`export.parts` and the X-Export-Parts header) so the app can
// offer the rest.
const EXPORT_SCANS_PER_PART = 500
const EXPORT_MAX_PAYMENTS = 1000
const EXPORT_SCAN_COLUMNS =
  'id, status, input_mode, created_at, scan_completed_at, resume_original_name, role_category, seniority_level, ' +
  'ats_score, passed, keyword_score, format_score, sections_score, content_score, ' +
  'job_description_text, job_description_url, raw_brain_dump_text, cover_letter_text, ' +
  'original_resume_data, rewritten_resume_data, fix_purchased, fix_tier, fix_ats_score, fix_generated_at, ' +
  'candidate_first_name, verify_hide_name, verify_expose_docx, verify_expose_pdf, ' +
  'verification_code, verification_status, verified_at, verification_revoked_at'
const EXPORT_PAYMENT_COLUMNS =
  'id, paystack_ref, amount_cents, currency, fix_tier, status, scan_id, referral_code, created_at, refunded_at, disputed_at'

// Anything that is not a positive integer is part 1 (a hand-edited ?part=abc
// should still hand back the file, not an error).
const parsePart = (raw) => { const n = parseInt(raw, 10); return Number.isFinite(n) && n >= 1 ? n : 1 }

async function exportMyData(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const part = parsePart(c.req.query ? c.req.query('part') : undefined)
  const from = (part - 1) * EXPORT_SCANS_PER_PART

  const { data: account, error: accErr } = await supabase.from('users')
    .select('name, email, email_verified, free_fix_credits, created_at, saved_profile').eq('id', user.id).single()
  if (accErr) throw accErr

  // Newest first, id as the tiebreak: created_at ties must not shuffle rows
  // between parts (a row could otherwise land in two parts or in none).
  let { data: scans, error: scanErr, count } = await supabase.from('scans')
    .select(EXPORT_SCAN_COLUMNS, { count: 'exact' }).eq('user_id', user.id)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .range(from, from + EXPORT_SCANS_PER_PART - 1)
  if (isRangeError(scanErr)) {
    // A part past the end: the total is still needed to say so.
    const head = await supabase.from('scans').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    if (head.error) throw head.error
    scans = []; count = head.count; scanErr = null
  }
  if (scanErr) throw scanErr

  const totalScans = count ?? (scans || []).length
  const parts = Math.max(1, Math.ceil(totalScans / EXPORT_SCANS_PER_PART))
  if (part > parts) return c.json({ success: false, message: `That export part does not exist — there ${parts === 1 ? 'is 1 part' : `are ${parts} parts`}.` }, 404)

  const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) =>
    [k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), v]))

  const payload = {
    exportedAt: new Date().toISOString(),
    export: { part, parts, totalScans, scansPerPart: EXPORT_SCANS_PER_PART },
    account: part === 1
      ? { name: account.name, email: account.email, emailVerified: account.email_verified,
          freeFixCredits: account.free_fix_credits, createdAt: account.created_at }
      : { email: account.email },   // later parts only need to say whose they are
    scans: (scans || []).map(camel)
  }

  if (part === 1) {
    const { data: payments, error: payErr } = await supabase.from('payments')
      .select(EXPORT_PAYMENT_COLUMNS).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(EXPORT_MAX_PAYMENTS)
    if (payErr) throw payErr
    payload.savedProfile = account.saved_profile || null
    payload.payments = (payments || []).map(camel)
    payload.paymentsTruncated = (payments || []).length >= EXPORT_MAX_PAYMENTS
  }

  return c.body(JSON.stringify(payload, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="passthrough-my-data${part > 1 ? `-part-${part}` : ''}.json"`,
    'X-Export-Parts': String(parts)
  })
}

module.exports = { getProfile, saveProfile, deleteProfile, exportMyData }
