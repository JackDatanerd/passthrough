// Profile & account-data endpoints, all auth-required.
//
// SECURITY NOTE on saveProfile: the request body is { scanId }, never raw
// resume data. The server looks up that scan (verifying ownership), reads
// ITS original_resume_data, and copies that into users.saved_profile. This
// is deliberate — accepting arbitrary client-supplied JSON here would let a
// malicious or buggy client inject unvalidated content into saved_profile,
// which later gets rendered into a DOCX/PDF for a completely different scan.
// Routing through an owned scan means the only data that can become a saved
// profile by SAVING is the structured resume the server itself derived from
// that user's own upload or brain dump (original_resume_data).
//
// The one door for client-typed content is updateProfile (PUT /api/profile),
// the saved-profile editor. It is held to exactly the standard of the existing
// scan-data editor (PATCH /scan/:id/resume-data): the same shared schema and
// size cap (lib/resumeData.js), blank lines dropped, a profile must already
// exist, and the write replaces only the resume content — never the
// ownership/source fields. (detectFabrication() is not part of this story: it
// only compares an original against a rewrite, and a saved profile is the
// original.)

const { getSupabase } = require('../config/supabase')
const { scanRowToCamel } = require('../lib/mappers')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { isRangeError, warnOnError } = require('../lib/db')
const { parseClientResumeData, hasResumeContent } = require('../lib/resumeData')
const { recordTombstones } = require('../lib/verification')
const constants = require('../config/constants')
const { SCAN_STATUSES, sanitizeSearch, applyScanFilters } = require('../lib/scanSearch')

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
// BUG FIX (fresh audit pass, Section 6): `latestTitle` used to be a bare
// `experience[0]?.title` — treating array order as "most recent first" with
// nothing backing that up. Neither extraction prompt in claude.service.js
// (parseResumeStructure for an uploaded resume, structureFreeformText for a
// brain dump) tells the model to return jobs in any particular order, and
// nothing downstream sorts the array before it's stored. The brain-dump path
// is the clearest case: it's explicitly "stream-of-consciousness... half-
// sentences" with no chronological structure to preserve in the first place.
// A full parser for freeform `dates` strings ("Jan 2020 – Present",
// "06/19-08/21", "Summer 2021"...) is its own source of confidently-wrong
// guesses — exactly what this app's own extraction prompts refuse to do
// elsewhere ("leave a field null/empty rather than guess"). The one signal
// cheap and unambiguous enough to trust without a date parser: a `dates`
// string containing "present"/"current" marks an ongoing job. When exactly
// one experience entry has that marker, it IS the latest job — no guess
// involved. Anything less certain (no marker anywhere, or more than one
// concurrent role) falls back to entry 0, same as before — a guess, not a
// guarantee, used only when nothing more certain is available.
function pickLatestTitle(experience) {
  if (!Array.isArray(experience) || !experience.length) return null
  const ongoing = experience.filter(e => /present|current/i.test(e?.dates || ''))
  if (ongoing.length === 1) return ongoing[0].title || null
  return experience[0]?.title || null
}

async function getProfile(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('users')
    .select('saved_profile, scans_today, scans_day_reset, notify_scan_results').eq('id', user.id).single()
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
    latestTitle:  pickLatestTitle(rd.experience),
    jobCount:     count(rd.experience),
    educationCount: count(rd.education),
    skillCount:   count(rd.skills)
  } : null

  return c.json({ success: true, data: {
    hasSavedProfile: !!saved?.resumeData,
    savedAt:         saved?.savedAt || null,
    editedAt:        saved?.editedAt || null,
    sourceScanId:    saved?.sourceScanId || null,
    summary,
    quota:           scanQuota(data),
    preferences:     { notifyScanResults: data.notify_scan_results !== false }
  }})
}

// Today's free-scan allowance, computed the way the increment_scan_count_if_under_limit RPC
// decides it (0008): a counter last touched before today's midnight is a stale day and counts
// as zero. The Worker runs in UTC, so "midnight" is UTC midnight — resetsAt says so in a form
// the client can show in the person's own time zone.
function scanQuota(row, now = new Date()) {
  const limit = constants.FREE_SCANS_PER_DAY
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const lastReset = row?.scans_day_reset ? Date.parse(row.scans_day_reset) : NaN
  const used = Number.isFinite(lastReset) && lastReset >= midnight ? Math.max(0, row.scans_today || 0) : 0
  return { limit, used: Math.min(used, limit), remaining: Math.max(0, limit - used), resetsAt: new Date(midnight + 86_400_000).toISOString() }
}

// GET /api/profile/data — the saved resume itself, for the editor only. getProfile deliberately
// withholds it (contact details, full history); this is the same owner reading their own data on
// an explicit request, so it carries no-store like every other account response.
async function getProfileData(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('users').select('saved_profile').eq('id', user.id).single()
  if (error) throw error
  const saved = data.saved_profile
  if (!saved?.resumeData) return c.json({ success: false, message: 'No saved profile.' }, 404)
  return c.json({ success: true, data: { resumeData: saved.resumeData, savedAt: saved.savedAt || null, editedAt: saved.editedAt || null } })
}

// PUT /api/profile  { resumeData } — correct the saved profile in place.
async function updateProfile(c) {
  const user = c.get('user')
  let body
  try { body = await c.req.json() } catch (_) { body = null }
  const checked = parseClientResumeData(body && typeof body === 'object' ? body.resumeData : undefined)
  if (!checked.ok) return c.json({ success: false, message: checked.message }, 400)
  if (!hasResumeContent(checked.data))
    return c.json({ success: false, message: 'Add at least one job, school, skill or a summary — an empty profile is not worth saving.' }, 400)

  const supabase = getSupabase(c.env)
  const { data: updated, error } = await supabase.rpc('set_saved_profile_resume', {
    p_user_id: user.id, p_resume: checked.data, p_edited_at: new Date().toISOString()
  })
  if (error) throw error
  if (!updated) return c.json({ success: false, message: 'No saved profile to edit. Save one from a completed scan first.' }, 404)
  return c.json({ success: true, message: 'Saved profile updated.', data: { resumeData: checked.data } })
}

// PATCH /api/profile/preferences  { notifyScanResults: boolean }
// Only the "your scan finished" result email is optional. Security notices, receipts and a
// delivered fix are never governed by this.
async function updatePreferences(c) {
  const user = c.get('user')
  let body
  try { body = await c.req.json() } catch (_) { body = null }
  const v = body && typeof body === 'object' ? body.notifyScanResults : undefined
  if (typeof v !== 'boolean') return c.json({ success: false, message: 'notifyScanResults must be true or false.' }, 400)
  const supabase = getSupabase(c.env)
  const { error } = await supabase.from('users').update({ notify_scan_results: v }).eq('id', user.id)
  if (error) throw error
  return c.json({ success: true, message: v ? 'Scan result emails are on.' : 'Scan result emails are off.', data: { notifyScanResults: v } })
}

const SAVEABLE_STATUSES = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED']

// POST /api/profile/save  { scanId }
async function saveProfile(c) {
  const user = c.get('user')
  // `null`, an array or a bare string are all valid JSON: reading `.scanId`
  // off them used to throw a TypeError and answer 500 for a client mistake.
  let body
  try { body = await c.req.json() } catch (_) { body = null }
  const scanId = body && typeof body === 'object' ? body.scanId : undefined
  // Only a literal `true` counts: the saved profile may carry corrections the person typed into
  // the Settings editor, and replacing those has to be an explicit choice (see the 409 below).
  const replaceEdited = !!body && typeof body === 'object' && body.replaceEdited === true
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
  // A scan still running, or one that failed, can hold half-written or unusable data (a brain
  // dump stores its structured copy before the scoring step that may still error). A profile
  // saved from it would later fail every rescan built on it.
  if (!SAVEABLE_STATUSES.includes(scan.status))
    return c.json({ success: false, message: scan.status === 'ERROR'
      ? 'This scan did not finish, so its resume data is not reliable enough to save. Save from a scan that completed.'
      : 'This scan is still being processed. Save the profile once it has finished.' }, 400)
  if (!hasResumeContent(scan.originalResumeData))
    return c.json({ success: false, message: 'This scan has no work history, education or skills to save.' }, 400)

  // Wrapped with savedAt (and now sourceScanId/roleCategory — see
  // getProfile's comment above) inside the single jsonb column — avoids a
  // schema change for what's otherwise a handful of small extra fields.
  const savedProfile = {
    resumeData:   scan.originalResumeData,
    savedAt:      new Date().toISOString(),
    sourceScanId: scan.id,
    roleCategory: scan.roleCategory || null
  }
  // Decided atomically in SQL (0056): a saved profile that carries `editedAt` holds corrections
  // made by hand, and an unconditional write here used to discard them without a word.
  const { data: written, error: updErr } = await supabase.rpc('save_profile_from_scan', {
    p_user_id: user.id, p_profile: savedProfile, p_replace_edited: replaceEdited
  })
  if (updErr) throw updErr
  if (!written)
    return c.json({ success: false, code: 'PROFILE_EDITED',
      message: 'Your saved profile has corrections you made by hand. Saving this scan replaces them — confirm to continue.' }, 409)

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
const EXPORT_SCANS_PER_PART = 250
const EXPORT_MAX_PAYMENTS = 1000
const EXPORT_SCAN_COLUMNS =
  'id, status, input_mode, created_at, scan_completed_at, resume_original_name, job_title, role_category, seniority_level, ' +
  'ats_score, passed, keyword_score, format_score, sections_score, content_score, ' +
  'job_description_text, job_description_url, raw_brain_dump_text, cover_letter_text, ' +
  'original_resume_data, rewritten_resume_data, fix_purchased, fix_tier, fix_ats_score, fix_generated_at, ' +
  'candidate_first_name, verify_hide_name, verify_expose_docx, verify_expose_pdf, ' +
  'verification_code, verification_status, verified_at, verification_revoked_at'
const EXPORT_MAX_SESSIONS = 200
const EXPORT_MAX_EMAILS = 500
const EXPORT_SESSION_COLUMNS = 'id, created_at, last_seen_at, absolute_expires_at, revoked_at, ip, user_agent'
const EXPORT_EMAIL_COLUMNS = 'subject, template, status, sent_at'
const EXPORT_PAYMENT_COLUMNS =
  'id, paystack_ref, amount_cents, currency, fix_tier, status, scan_id, referral_code, created_at, refunded_at, disputed_at'

// The export's paging cursor: the (created_at, id) of the last scan of a full part, handed back
// in X-Export-Cursor and sent as ?cursor= for the next part. Offset paging alone (`?part=N` ->
// range(N*250..)) shifts when a scan is deleted between two downloads, so one scan could fall
// through the gap between parts; a keyset cursor cannot. Without a (valid) cursor the part falls
// back to the offset, as before. Strict shape: it is spliced into a PostgREST filter string.
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const parseCursor = (raw) => { const m = typeof raw === 'string' ? CURSOR_RE.exec(raw) : null; return m ? { createdAt: m[1], id: m[2] } : null }

// Anything that is not a positive integer is part 1 (a hand-edited ?part=abc
// should still hand back the file, not an error).
const pendingEmailLive = (row) => !!row.pending_email && Number.isFinite(Date.parse(row.pending_email_expiry)) && Date.parse(row.pending_email_expiry) > Date.now()
const parsePart = (raw) => { const n = parseInt(raw, 10); return Number.isFinite(n) && n >= 1 ? n : 1 }

async function exportMyData(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const part = parsePart(c.req.query ? c.req.query('part') : undefined)
  const cursor = parseCursor(c.req.query ? c.req.query('cursor') : undefined)
  const from = (part - 1) * EXPORT_SCANS_PER_PART

  const { data: account, error: accErr } = await supabase.from('users')
    .select('name, email, email_verified, free_fix_credits, created_at, saved_profile, pending_email, pending_email_expiry, notify_scan_results, ' +
      'terms_accepted_at, terms_version, last_login_at, last_login_ip, previous_login_at, previous_login_ip').eq('id', user.id).single()
  if (accErr) throw accErr

  // Newest first, id as the tiebreak: created_at ties must not shuffle rows
  // between parts (a row could otherwise land in two parts or in none).
  let scans, scanErr, count
  if (cursor) {
    // Keyset page: everything strictly after the cursor in (created_at desc, id desc) order.
    // No offset, so a scan deleted since the previous part cannot shift this one.
    ;({ data: scans, error: scanErr } = await supabase.from('scans')
      .select(EXPORT_SCAN_COLUMNS).eq('user_id', user.id)
      .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(EXPORT_SCANS_PER_PART))
    if (scanErr) throw scanErr
    // The total is still the whole account's, not just what is left after the cursor.
    const head = await supabase.from('scans').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    if (head.error) throw head.error
    count = head.count
  } else {
    ;({ data: scans, error: scanErr, count } = await supabase.from('scans')
      .select(EXPORT_SCAN_COLUMNS, { count: 'exact' }).eq('user_id', user.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + EXPORT_SCANS_PER_PART - 1))
    if (isRangeError(scanErr)) {
      // A part past the end: the total is still needed to say so.
      const head = await supabase.from('scans').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      if (head.error) throw head.error
      scans = []; count = head.count; scanErr = null
    }
    if (scanErr) throw scanErr
  }

  const totalScans = count ?? (scans || []).length
  const parts = Math.max(1, Math.ceil(totalScans / EXPORT_SCANS_PER_PART))
  // A cursor part is exempt: scans deleted since part 1 can shrink the total below the part
  // number the person is legitimately on, and that must not turn into a 404 mid-export.
  if (!cursor && part > parts) return c.json({ success: false, message: `That export part does not exist — there ${parts === 1 ? 'is 1 part' : `are ${parts} parts`}.` }, 404)

  const camel = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) =>
    [k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), v]))

  const payload = {
    exportedAt: new Date().toISOString(),
    export: { part, parts: Math.max(parts, part), totalScans, scansPerPart: EXPORT_SCANS_PER_PART },
    account: part === 1
      ? { name: account.name, email: account.email, emailVerified: account.email_verified,
          freeFixCredits: account.free_fix_credits, createdAt: account.created_at,
          // Only a change that can still be confirmed: an expired one is dead (the account's own
          // read, lib/authUser.js, hides it too).
          pendingEmail: pendingEmailLive(account) ? account.pending_email : null, notifyScanResults: account.notify_scan_results !== false,
          termsAcceptedAt: account.terms_accepted_at ?? null, termsVersion: account.terms_version ?? null,
          lastLoginAt: account.last_login_at ?? null, lastLoginIp: account.last_login_ip ?? null,
          previousLoginAt: account.previous_login_at ?? null, previousLoginIp: account.previous_login_ip ?? null }
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

    // The sign-in devices and mail history are data the account holds about its owner too.
    const { data: sessions, error: sessErr } = await supabase.from('user_sessions')
      .select(EXPORT_SESSION_COLUMNS).eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(EXPORT_MAX_SESSIONS)
    if (sessErr) throw sessErr
    payload.sessions = (sessions || []).map(camel)
    const { data: emails, error: mailErr } = await supabase.from('email_logs')
      .select(EXPORT_EMAIL_COLUMNS).eq('to', account.email)
      .order('sent_at', { ascending: false }).limit(EXPORT_MAX_EMAILS)
    if (mailErr) throw mailErr
    payload.emailsSent = (emails || []).map(camel)
    payload.emailsTruncated = (emails || []).length >= EXPORT_MAX_EMAILS
    // Mail is logged by recipient address only, so this list is what was sent to the address the
    // account has NOW. Say so rather than let it read as the complete mail history.
    payload.emailsNote = `Messages sent to ${account.email}. Mail sent to an address this account used earlier is not linked to it and is not listed here.`
  }

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename=\"passthrough-my-data${part > 1 ? `-part-${part}` : ''}.json\"`,
    'X-Export-Parts': String(parts)
  }
  // A full part may have a successor: where it starts, immune to deletions in between.
  const last = (scans || [])[(scans || []).length - 1]
  if (last && scans.length === EXPORT_SCANS_PER_PART && last.created_at && last.id) headers['X-Export-Cursor'] = `${last.created_at}|${last.id}`
  return c.body(JSON.stringify(payload, null, 2), 200, headers)
}

// DELETE /api/profile/scans[?status=&search=] — remove the account's scan history, or just the
// scans a dashboard filter is showing (not the account, not payments).
//
// Scans hold the most personal data in the app (resume text, structured history, job
// descriptions) and could only be removed one at a time or by deleting the whole account. This
// removes them in small batches — each call deletes up to PURGE_BATCH scans plus their stored
// files — and says how many are left, so the app can loop with a progress message instead of
// one request that blows the Worker's subrequest/time budget on a large history.
//
// Same rules as deleteScan for each scan: nothing still being processed (untouched for an hour
// means the job died and does not block), nothing with a payment in flight; a paid scan CAN be
// deleted, its verification page then reads "removed by its owner", and its payment record
// stays. The saved profile is a separate copy and is kept (only its source pointer is cleared).
const PURGE_BATCH = 25
const IN_FLIGHT_STATUSES = ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']
const IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000

// Optional ?status= / ?search= narrow the purge to what the dashboard's filters are showing (the
// same definitions as GET /scan/history, lib/scanSearch.js). A filter that cannot be honoured is
// refused rather than ignored: ignoring it would turn "delete these failed scans" into "delete
// everything".
function purgeFilters(c) {
  const q = (k) => (c.req.query ? c.req.query(k) : undefined)
  const rawStatus = q('status'), rawSearch = q('search')
  const status = rawStatus ? String(rawStatus) : ''
  if (status && !SCAN_STATUSES.includes(status)) return { error: 'Unknown status filter.' }
  const search = sanitizeSearch(rawSearch)
  if (rawSearch && !search && !status) return { error: 'That search matches everything. To delete every scan, use Settings → Scan history.' }
  return { status, search }
}

// R2 `delete()` takes a whole list of keys in ONE call; one call per key made a batch of fixed
// scans (3 objects each) cost dozens of subrequests. A failed bulk call falls back to key-by-key
// so one bad object still cannot spare the rest.
async function deleteStoredFiles(env, rows) {
  const keys = []
  for (const row of rows) for (const key of [row.resume_path, row.resume_ats_path, row.resume_pdf_path]) if (key) keys.push({ key, scanId: row.id })
  if (!keys.length) return
  try { await env.RESUMES_BUCKET.delete(keys.map(k => k.key)); return }
  catch (e) { console.error(`deleteScanHistory: bulk R2 delete of ${keys.length} object(s) failed, retrying one by one:`, e.message) }
  for (const { key, scanId } of keys) {
    try { await env.RESUMES_BUCKET.delete(key) }
    catch (e) { console.error(`deleteScanHistory: failed to delete R2 object ${key} for scan ${scanId}:`, e.message) }
  }
}

async function deleteScanHistory(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const since = new Date(Date.now() - IN_FLIGHT_WINDOW_MS).toISOString()
  const filters = purgeFilters(c)
  if (filters.error) return c.json({ success: false, message: filters.error }, 400)

  const { data: rows, error } = await applyScanFilters(supabase.from('scans')
    .select('id, status, updated_at, resume_path, resume_ats_path, resume_pdf_path, verification_code, resume_hash, resume_pdf_hash, resume_hash_history')
    .eq('user_id', user.id)
    .or(`status.not.in.(${IN_FLIGHT_STATUSES.join(',')}),updated_at.lte.${since}`), filters)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(PURGE_BATCH)
  if (error) throw error

  let batch = rows || []
  if (batch.length) {
    const { data: busy, error: payErr } = await supabase.from('payments')
      .select('scan_id').in('scan_id', batch.map(r => r.id)).eq('status', 'PENDING').gt('created_at', since)
    if (payErr) throw payErr
    const held = new Set((busy || []).map(p => p.scan_id))
    batch = batch.filter(r => !held.has(r.id))
  }

  let deleted = 0
  if (batch.length) {
    const { data: removed, error: delErr } = await supabase.from('scans')
      .delete().in('id', batch.map(r => r.id)).eq('user_id', user.id).select('id')
    if (delErr) throw delErr
    const gone = new Set((removed || []).map(r => r.id))
    const goneRows = batch.filter(r => gone.has(r.id))
    deleted = goneRows.length

    if (goneRows.length) {
      await recordTombstones(supabase, goneRows)
      await deleteStoredFiles(c.env, goneRows)
      warnOnError(await supabase.rpc('clear_saved_profile_source', { p_user_id: user.id, p_scan_ids: goneRows.map(r => r.id) }),
        'deleteScanHistory: clear saved-profile source')
    }
  }

  // `remaining` counts what is still left UNDER THE SAME FILTERS, so a filtered purge reports
  // its own progress and ends at 0 instead of chasing scans it was never asked to touch.
  const { count, error: countErr } = await applyScanFilters(supabase.from('scans')
    .select('id', { count: 'exact', head: true }).eq('user_id', user.id), filters)
  if (countErr) throw countErr
  return c.json({ success: true, data: { deleted, remaining: count ?? 0 } })
}

module.exports = { getProfile, getProfileData, updateProfile, updatePreferences, saveProfile, deleteProfile, deleteScanHistory, exportMyData, scanQuota }
