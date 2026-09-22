// Public verification endpoints (no auth) — what a hiring manager's browser talks to.
//
// Section 7 (Verify) audit — summary of what this file now does differently:
//
//  * The integrity check finally means something on the client: the response
//    carries the SHA-256 fingerprints so a reader can check the file THEY were
//    sent (in their browser, nothing uploaded) — the server-side re-hash below
//    only ever compared R2 against a hash we wrote ourselves and could never see
//    a candidate's edited copy. Fingerprints now cover the PDF too (the file
//    candidates are told to email), plus the hashes of superseded versions so an
//    older delivered file reads "earlier version", not "modified".
//  * `verified` (score passed AND integrity verified AND not revoked) is what the
//    headline must key off. `passed` alone kept a green "Verified ✓" on a page
//    whose integrity check had failed.
//  * A page can be revoked (owner unpublish, refund, admin) → 410.
//  * View counting: skips previews, bots, the owner and repeat visits by the same
//    visitor within a day; goes through waitUntil; and READS the RPC's { error }
//    (supabase-js resolves with it rather than rejecting, so the old
//    `.then(_, onRejected)` swallowed a missing/denied function forever).
//  * Malformed codes are rejected before the DB, and unknown-code misses are
//    throttled per IP.
//  * Downloads validate `type` and only advertise files that exist.

const constants = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const rateLimiter = require('../middleware/rateLimiter')
const { runInBackground } = require('../lib/background')
const { STATUS, normalizeCode, isPlausibleCode, isBotUserAgent, visitorKey } = require('../lib/verification')

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PAGE_COLUMNS =
  'candidate_first_name, ats_score, fix_ats_score, verified_at, role_category, seniority_level, ' +
  'verification_views, resume_ats_path, resume_pdf_path, resume_hash, resume_pdf_hash, resume_hash_history, ' +
  'verify_expose_docx, verify_expose_pdf, verify_hide_name, verification_status, verification_revoked_at, user_id'

const clientIp = c => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'

function noStore(c) {
  // The integrity verdict and revocation state must never be served stale.
  c.header('Cache-Control', 'no-store')
  // Verification pages are for whoever the candidate sent the link to, not for search.
  c.header('X-Robots-Tag', 'noindex, nofollow')
}

// Shared by all three endpoints. Returns { row } or { response }.
async function loadByCode(c, { columns = PAGE_COLUMNS } = {}) {
  const code = normalizeCode(c.req.param('code'))
  const ip = clientIp(c)

  if (await rateLimiter.isVerifyMissLimited(c.env, ip))
    return { response: c.json({ success: false, message: 'Too many lookups. Please wait a while.' }, 429) }

  if (!isPlausibleCode(code)) {
    await rateLimiter.recordVerifyMiss(c.env, ip)
    return { response: c.json({ success: false, message: 'Verification not found.' }, 404) }
  }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select(columns).eq('verification_code', code).maybeSingle()
  if (error) throw error
  if (!row) {
    await rateLimiter.recordVerifyMiss(c.env, ip)
    return { response: c.json({ success: false, message: 'Verification not found.' }, 404) }
  }
  return { row, code, supabase }
}

function revokedResponse(c, row) {
  return c.json({
    success: false, code: 'REVOKED',
    message: 'This verification has been revoked and is no longer valid.',
    revokedAt: row.verification_revoked_at || null,
  }, 410)
}

async function checkIntegrity(env, row) {
  // Starts (and on any failure stays) 'unknown' rather than defaulting to
  // 'verified' — this must never fail OPEN.
  if (!row.resume_ats_path || !row.resume_hash) return 'unknown'
  try {
    const obj = await env.RESUMES_BUCKET.get(row.resume_ats_path)
    if (!obj) return 'unknown'
    const actual = await cryptoLib.sha256Bytes(await obj.arrayBuffer())
    return actual === row.resume_hash ? 'verified' : 'modified'
  } catch (err) {
    console.error('Integrity check failed:', err.message)
    return 'unknown'
  }
}

async function incrementViews(env, code) {
  const { error } = await getSupabase(env).rpc('increment_verification_views', { p_code: code })
  // supabase-js RESOLVES with { error } — it does not reject.
  if (error) console.error('[verify] increment_verification_views failed:', error.message)
}

// True when this request was counted as a view.
async function maybeCountView(c, code, row) {
  const ua = c.req.header('user-agent') || ''
  if (isBotUserAgent(ua)) return false
  const user = c.get ? c.get('user') : null
  if (user && row.user_id && user.id === row.user_id) return false   // the owner checking their own link

  const kv = c.env.RATE_LIMIT_KV
  if (kv) {
    try {
      const key = await visitorKey(code, clientIp(c), ua)
      if (await kv.get(key)) return false                            // already counted today
      await kv.put(key, '1', { expirationTtl: 24 * 60 * 60 })
    } catch (err) {
      console.error('[verify] view dedupe unavailable, counting anyway:', err.message)
    }
  }
  runInBackground(c, incrementViews(c.env, code))
  return true
}

function fingerprintsFor(row) {
  const history = Array.isArray(row.resume_hash_history) ? row.resume_hash_history : []
  const previous = []
  for (const h of history) {
    if (h?.docx && h.docx !== row.resume_hash) previous.push({ kind: 'docx', hash: h.docx, at: h.at || null })
    if (h?.pdf && h.pdf !== row.resume_pdf_hash) previous.push({ kind: 'pdf', hash: h.pdf, at: h.at || null })
  }
  return { docx: row.resume_hash || null, pdf: row.resume_pdf_hash || null, previous }
}

// GET /api/verify/:code[?preview=1]
// `preview=1` is sent by the Pages Function that builds link-preview meta tags:
// it must neither count as a view nor pay for a full R2 read + re-hash.
async function getVerification(c) {
  noStore(c)
  const loaded = await loadByCode(c)
  if (loaded.response) return loaded.response
  const { row, code } = loaded

  if (row.verification_status === STATUS.REVOKED) return revokedResponse(c, row)

  const preview = c.req.query('preview') === '1'
  const verifiedScore = row.fix_ats_score ?? row.ats_score
  const passed = verifiedScore != null && verifiedScore >= constants.ATS_BADGE_THRESHOLD

  const integrityStatus = preview ? 'unchecked' : await checkIntegrity(c.env, row)
  const counted = preview ? false : await maybeCountView(c, code, row)

  return c.json({ success: true, data: {
    candidateFirstName: row.verify_hide_name ? null : (row.candidate_first_name || null),
    atsScore:           verifiedScore,
    passed,
    // The ONLY flag a headline may use to say "Verified".
    verified:           preview ? null : (passed && integrityStatus === 'verified'),
    roleCategory:       row.role_category,
    seniorityLevel:     row.seniority_level,
    verifiedAt:         row.verified_at,
    integrityStatus,
    verificationViews:  (row.verification_views || 0) + (counted ? 1 : 0),
    // Only advertise files that can actually be served.
    exposeDocx:         !!(row.verify_expose_docx && row.resume_ats_path),
    exposePdf:          !!(row.verify_expose_pdf && row.resume_pdf_path),
    fingerprints:       fingerprintsFor(row),
  }})
}

// GET /api/verify/:code/download?type=docx|pdf
async function downloadVerifiedFile(c) {
  noStore(c)
  const type = String(c.req.query('type') || 'docx').toLowerCase()
  if (type !== 'docx' && type !== 'pdf')
    return c.json({ success: false, message: 'type must be "docx" or "pdf".' }, 400)

  const loaded = await loadByCode(c, { columns:
    'resume_ats_path, resume_pdf_path, verify_expose_docx, verify_expose_pdf, verification_status, verification_revoked_at' })
  if (loaded.response) return loaded.response
  const { row, code } = loaded

  if (row.verification_status === STATUS.REVOKED) return revokedResponse(c, row)

  const wantPdf = type === 'pdf'
  const allowed = wantPdf ? row.verify_expose_pdf : row.verify_expose_docx
  if (!allowed) return c.json({ success: false, message: 'The owner has not made this file available.' }, 403)

  const key = wantPdf ? row.resume_pdf_path : row.resume_ats_path
  if (!key) return c.json({ success: false, message: 'File not available.' }, 404)

  const obj = await c.env.RESUMES_BUCKET.get(key)
  if (!obj) return c.json({ success: false, message: 'File not available.' }, 404)

  c.header('Content-Type', wantPdf ? 'application/pdf' : DOCX_MIME)
  c.header('Content-Disposition', `${wantPdf ? 'inline' : 'attachment'}; filename="Passthrough-${code}.${wantPdf ? 'pdf' : 'docx'}"`)
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(obj.body)
}

// ── live badge (SVG) ────────────────────────────────────────────────────────
// SECTION 7 AUDIT (feature gap): candidates had nothing they could embed in a
// LinkedIn "featured" link, a portfolio or a README that reflects the page's
// LIVE state. Deliberately cheap: no R2 read, no view count, cacheable.

const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

function renderBadge(label, value, color) {
  const w = t => Math.round(String(t).length * 6.6 + 14)
  const lw = w(label), vw = w(value), total = lw + vw
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">` +
    `<title>${esc(label)}: ${esc(value)}</title>` +
    `<rect width="${lw}" height="20" fill="#374151"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>` +
    `<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">` +
    `<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`
}

async function getBadge(c) {
  const loaded = await loadByCode(c, { columns: 'ats_score, fix_ats_score, verification_status' })
  if (loaded.response) return loaded.response
  const { row } = loaded

  let value, color
  if (row.verification_status === STATUS.REVOKED) { value = 'revoked'; color = '#6b7280' }
  else {
    const score = row.fix_ats_score ?? row.ats_score
    if (score != null && score >= constants.ATS_BADGE_THRESHOLD) { value = `${Math.round(score)}/100`; color = '#15803d' }
    else { value = score != null ? `scan ${Math.round(score)}/100` : 'scan report'; color = '#b45309' }
  }
  const label = value === 'revoked' || String(value).startsWith('scan') ? 'Passthrough' : 'Passthrough Verified'
  c.header('Content-Type', 'image/svg+xml; charset=utf-8')
  c.header('Cache-Control', 'public, max-age=300')
  c.header('X-Robots-Tag', 'noindex')
  return c.body(renderBadge(label, value, color))
}

module.exports = { getVerification, downloadVerifiedFile, getBadge, renderBadge }
