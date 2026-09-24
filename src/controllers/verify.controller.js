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
//    older delivered file reads "earlier version", not "modified" — each with
//    the date it was ACTUALLY superseded (the next version's start / the
//    current version's verified_at), not its own start date, which is all
//    resume_hash_history itself records (see fingerprintsFor below).
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
//
// Round-3 audit: every unknown-code miss now counts no matter what the request's
// Sec-Fetch-* headers claim (a non-browser client simply sets them — see loadByCode);
// the limiters bucket IPv6 by /48; new codes are 10 characters (old 6-character ones
// still resolve); downloads refuse a file that no longer matches its fingerprint;
// integrity says 'partial' rather than 'verified' when a PDF was never fingerprinted;
// a deleted page answers 410 "removed" instead of an indistinguishable 404; and
// GET /api/verify/by-hash/:sha256 finds the page for a file a reader already holds.
//
// Round-2 audit additions: verify traffic is exempt from the generic per-IP
// limiter and has its own (rateLimiter.js verifyRead + scoped miss counters);
// misses can no longer be spent by an <img> tag or a hostile page; the badge is
// edge-cached, always a real image, and has its own ceilings; an optional shared
// secret lets the link-preview Function skip the per-IP limits.

const constants = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const rateLimiter = require('../middleware/rateLimiter')
const { runInBackground } = require('../lib/background')
const { STATUS, SHA256_RE, normalizeCode, isPlausibleCode, isBotUserAgent, visitorKey, isTrustedPreview } = require('../lib/verification')
// SECTION 7 AUDIT FIX (bug): this file used to define its own local
// `clientIp` (`cf-connecting-ip || x-forwarded-for || 'unknown'`), which
// trusts the client-supplied X-Forwarded-For header unconditionally — every
// OTHER IP-keyed control in the app (rateLimiter.js, scan.controller.js's
// quota bypass, auth.controller.js's lockout) goes through this shared,
// hardened helper instead, which only honours X-Forwarded-For outside
// production for exactly that reason. This endpoint's own anti-enumeration
// guard (isVerifyMissLimited/recordVerifyMiss below) exists specifically to
// stop someone guessing across the ~1.07 billion possible verification
// codes — keying it off a spoofable header defeated the point of having it.
const { clientIp, rateKeyIp } = require('../lib/clientIp')

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PAGE_COLUMNS =
  'candidate_first_name, ats_score, fix_ats_score, verified_at, role_category, seniority_level, ' +
  'verification_views, resume_ats_path, resume_pdf_path, resume_hash, resume_pdf_hash, resume_hash_history, ' +
  'verify_expose_docx, verify_expose_pdf, verify_hide_name, verification_status, verification_revoked_at, user_id'

function noStore(c) {
  // The integrity verdict and revocation state must never be served stale.
  c.header('Cache-Control', 'no-store')
  // Verification pages are for whoever the candidate sent the link to, not for search.
  c.header('X-Robots-Tag', 'noindex, nofollow')
}

// Shared by all three endpoints. Returns { row } or { response }.
//
// ROUND-2 AUDIT (Section 7). What changed here and why:
//  * misses are counted in a scope: 'page' (30 / 15 min) for the JSON page and
//    downloads, 'badge' (300 / 15 min, separate counter) for the embeddable image
//    — an <img> tag pointed at random codes could otherwise exhaust the counter
//    that also guards real lookups (see rateLimiter.js);
//  * a code that is not even shaped like one is answered without recording a miss
//    (it never touches the DB, and nothing can be learned from it);
//  * ROUND-3 AUDIT FIX (bug, security): round 2 also let any request that CLAIMED, via
//    Sec-Fetch-Mode/Dest, to be an <img>/no-cors load skip the miss counter. Those
//    are only unforgeable inside a browser — curl or a script just sends
//    `Sec-Fetch-Dest: image`, was never counted, and the 30-per-15-min brake
//    silently became the 240-per-5-min read cap (about 38x weaker). A header the
//    caller controls cannot gate a security counter, so EVERY miss now counts. The
//    price is that a hostile page can again spend a visitor's PAGE budget with
//    fetch(..., {mode:'cors'}); that is a lookup annoyance, the other was a scraper
//    with a free pass, and the badge has its own, much higher, counter;
//  * the trusted link-preview fetch (shared secret) is exempt from the limiter;
//  * a 429 says when to come back.
async function loadByCode(c, { columns = PAGE_COLUMNS, scope = 'page' } = {}) {
  const code = normalizeCode(c.req.param('code'))
  const ip = clientIp(c)
  const trusted = isTrustedPreview(c)

  if (!trusted && await rateLimiter.isVerifyMissLimited(c.env, ip, undefined, scope))
    return { response: c.json({ success: false, message: 'Too many lookups. Please wait a while.' }, 429, { 'Retry-After': '900' }) }

  if (!isPlausibleCode(code))
    return { response: c.json({ success: false, message: 'Verification not found.' }, 404), notFound: true, code }

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select(columns).eq('verification_code', code).maybeSingle()
  if (error) throw error
  if (!row) {
    if (!trusted) await rateLimiter.recordVerifyMiss(c.env, ip, undefined, scope)
    // A page whose owner deleted it (or their account) answers "removed" rather than a
    // 404 that looks exactly like a mistyped code on a printed resume.
    if (await isRemovedCode(supabase, code))
      return { response: c.json({ success: false, code: 'REMOVED', message: 'This verification page was removed by its owner.' }, 410), notFound: true, removed: true, code }
    return { response: c.json({ success: false, message: 'Verification not found.' }, 404), notFound: true, code }
  }
  return { row, code, supabase }
}

// verification_tombstones (migration 0036) holds just the code of a deleted page. Fails
// SOFT: if the table is not there yet, a deleted page simply reads as not found, as before.
async function isRemovedCode(supabase, code) {
  try {
    const { data, error } = await supabase.from('verification_tombstones').select('code').eq('code', code).maybeSingle()
    if (error) { console.error('[verify] tombstone lookup failed:', error.message); return false }
    return !!data
  } catch (err) {
    console.error('[verify] tombstone lookup failed:', err.message)
    return false
  }
}

function revokedResponse(c, row) {
  return c.json({
    success: false, code: 'REVOKED',
    message: 'This verification has been revoked and is no longer valid.',
    revokedAt: row.verification_revoked_at || null,
  }, 410)
}

// SECTION 7 AUDIT FIX (bug): this used to hash only resume_ats_path/resume_hash
// (the docx) — resume_pdf_path/resume_pdf_hash were never checked, even though
// the PDF is independently exposable for download and is the file candidates
// are actually told to email. A corrupted/tampered PDF object in R2 would have
// read "Unmodified" forever. Checks the docx first (existing behavior/cost for
// the common case), then the PDF only if this row has one on file — 'verified'
// now means BOTH stored files match what we hashed at generation time.
async function checkIntegrity(env, row) {
  // Starts (and on any failure stays) 'unknown' rather than defaulting to
  // 'verified' — this must never fail OPEN.
  if (!row.resume_ats_path || !row.resume_hash) return 'unknown'
  try {
    const docxObj = await env.RESUMES_BUCKET.get(row.resume_ats_path)
    if (!docxObj) return 'unknown'
    const docxActual = await cryptoLib.sha256Bytes(await docxObj.arrayBuffer())
    if (docxActual !== row.resume_hash) return 'modified'

    if (row.resume_pdf_path) {
      // ROUND-3 AUDIT FIX (bug): a PDF with no stored fingerprint (a page issued before
      // migration 0025 added resume_pdf_hash) used to be skipped and the page still said
      // "verified" and "has not been modified" while offering that PDF for download.
      // 'partial' = the Word file checks out, the PDF cannot be checked. Never a green tick.
      if (!row.resume_pdf_hash) return 'partial'
      const pdfObj = await env.RESUMES_BUCKET.get(row.resume_pdf_path)
      if (!pdfObj) return 'unknown'
      const pdfActual = await cryptoLib.sha256Bytes(await pdfObj.arrayBuffer())
      if (pdfActual !== row.resume_pdf_hash) return 'modified'
    }
    return 'verified'
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

// FIX (Section 7 audit, bug): `resume_hash_history` entries store each old
// version's OWN `verified_at` — i.e. when THAT version was generated and
// became current (see scan.controller.js's nextHashHistory) — not when it
// was superseded. `fileFingerprint.js`'s contract (and the "current until"
// copy on the Verify page) both promise the LATTER: the moment a reader's
// older file stopped being current. Those are off by exactly one
// regeneration cycle — a file that was current from Jan 1 to Mar 1 was
// being reported as "current until Jan 1" (the date it STARTED, not ended).
//
// `history` is chronological (oldest first, most-recently-superseded last),
// so entry i's real "current until" moment is entry i+1's own `at` (the
// next version's start = this one's end) — or, for the last historical
// entry, `row.verified_at` (the CURRENT version's start = when it took
// over). Both docx and pdf changes from the same regeneration round share
// one `at` in the source data, so this is computed once per round and
// applied to whichever of the pair actually changed.
function fingerprintsFor(row) {
  const history = Array.isArray(row.resume_hash_history) ? row.resume_hash_history : []
  const previous = []
  for (let i = 0; i < history.length; i++) {
    const h = history[i]
    const supersededAt = history[i + 1]?.at || row.verified_at || null
    if (h?.docx && h.docx !== row.resume_hash) previous.push({ kind: 'docx', hash: h.docx, at: supersededAt })
    if (h?.pdf && h.pdf !== row.resume_pdf_hash) previous.push({ kind: 'pdf', hash: h.pdf, at: supersededAt })
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
    'resume_ats_path, resume_pdf_path, resume_hash, resume_pdf_hash, verify_expose_docx, verify_expose_pdf, verification_status, verification_revoked_at' })
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

  // ROUND-3 AUDIT FIX (bug): this used to stream whatever sat in R2 without comparing it
  // to the fingerprint the page advertises — so a tampered object was served under the
  // Passthrough name while the page next to the button said "Modified". Now the bytes are
  // hashed first and refused on a mismatch. Bytes with no stored hash (a PDF from before
  // 0025) are still served, labelled as unchecked, and the response carries the digest so
  // the recipient can compare it themselves.
  const bytes = await obj.arrayBuffer()
  const actual = await cryptoLib.sha256Bytes(bytes)
  const expected = wantPdf ? row.resume_pdf_hash : row.resume_hash
  if (expected && actual !== expected)
    return c.json({ success: false, code: 'INTEGRITY_FAILED', message: 'This file no longer matches its verified fingerprint, so it is not being served.' }, 409)

  c.header('Content-Type', wantPdf ? 'application/pdf' : DOCX_MIME)
  c.header('Content-Disposition', `${wantPdf ? 'inline' : 'attachment'}; filename="Passthrough-${code}.${wantPdf ? 'pdf' : 'docx'}"`)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Passthrough-SHA256', actual)
  c.header('X-Passthrough-Integrity', expected ? 'verified' : 'unchecked')
  c.header('Content-Length', String(bytes.byteLength))
  return c.body(bytes)
}

// GET /api/verify/by-hash/:sha256
// The reader has a file but no link (an ATS strips them, a printout loses them): they hash
// it in their browser (nothing is uploaded) and this finds the page it belongs to — a
// current file, or one an earlier delivery of it. Same limiter, and the same miss counter,
// as a code lookup: a hash is 256 bits and cannot be guessed, but this must not be a
// cheaper oracle than /:code is.
async function lookupByHash(c) {
  noStore(c)
  const hash = String(c.req.param('hash') || '').trim().toLowerCase()
  const ip = clientIp(c)
  if (await rateLimiter.isVerifyMissLimited(c.env, ip, undefined, 'page'))
    return c.json({ success: false, message: 'Too many lookups. Please wait a while.' }, 429, { 'Retry-After': '900' })
  if (!SHA256_RE.test(hash))
    return c.json({ success: false, message: 'That is not a SHA-256 fingerprint.' }, 400)

  const supabase = getSupabase(c.env)
  const cols = 'verification_code, verification_status'
  const attempts = [
    () => supabase.from('scans').select(cols).eq('resume_hash', hash),
    () => supabase.from('scans').select(cols).eq('resume_pdf_hash', hash),
    () => supabase.from('scans').select(cols).contains('resume_hash_history', [{ docx: hash }]),
    () => supabase.from('scans').select(cols).contains('resume_hash_history', [{ pdf: hash }]),
  ]
  const shapes = [['current', 'docx'], ['current', 'pdf'], ['previous', 'docx'], ['previous', 'pdf']]
  for (let i = 0; i < attempts.length; i++) {
    const { data, error } = await attempts[i]().not('verification_code', 'is', null).order('verified_at', { ascending: false }).limit(1)
    if (error) throw error
    const hit = (data || [])[0]
    if (hit && hit.verification_code)
      return c.json({ success: true, data: { code: hit.verification_code, match: shapes[i][0], kind: shapes[i][1], revoked: hit.verification_status === STATUS.REVOKED } })
  }
  if (!isTrustedPreview(c)) await rateLimiter.recordVerifyMiss(c.env, ip, undefined, 'page')
  return c.json({ success: false, code: 'NO_MATCH', message: 'No Passthrough verification matches that file.' }, 404)
}

// ── live badge (SVG) ────────────────────────────────────────────────────────
// SECTION 7 AUDIT (feature gap): candidates had nothing they could embed in a
// LinkedIn "featured" link, a portfolio or a README that reflects the page's
// LIVE state. No view count — embeds get looked at far more than clicked
// through, and counting every impression as a "view" would inflate the number
// on the real page.
//
// The badge is the one surface people see WITHOUT clicking through, so its claim
// has to satisfy the same invariant as the page's headline: passed AND integrity
// verified AND not revoked (it used to say "Verified" on score alone). That
// costs an R2 read + re-hash, so the finished badge is cached at the edge with
// the Cache API — see getBadge below for the caching, quota and not-found rules.

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

// ROUND-2 AUDIT (Section 7): the badge is now
//  * cached at the edge with the Cache API (Cloudflare does NOT cache a Worker's
//    response just because it carries Cache-Control — the old comment's "bounded
//    to once per 5 minutes per code at the edge" was not true, so every single
//    impression paid for an R2 read + SHA-256 of both files);
//  * a real image in every case — an unknown code used to answer JSON, i.e. a
//    broken image in someone's README, uncacheable, and re-requested forever;
//  * bounded per IP by its own quota and its own miss counter (see loadByCode).
const BADGE_TTL_SECONDS = 300
const BADGE_UNSETTLED_TTL_SECONDS = 60   // an integrity check that could not run must not stick for 5 minutes
const BADGE_IP_QUOTA = 1200              // per IP per 15 min — cache misses only; a cost ceiling, not a person-limit

function badgeHeaders(ttl) {
  return {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': `public, max-age=${ttl}`,
    'X-Robots-Tag': 'noindex',
  }
}

function badgeCache() {
  try { return typeof caches !== 'undefined' && caches.default ? caches.default : null } catch (_) { return null }
}

function badgeCacheKey(c) {
  const url = new URL(c.req.url || 'https://badge.invalid/')
  url.search = ''
  url.pathname = url.pathname.replace(/\/([^/]+)\/badge\.svg$/i, (_, code) => `/${normalizeCode(code)}/badge.svg`)
  return new Request(url.toString())
}

function sendBadge(c, svg, ttl, cache, key) {
  const headers = badgeHeaders(ttl)
  for (const [k, v] of Object.entries(headers)) c.header(k, v)
  if (cache && key) {
    try { runInBackground(c, cache.put(key, new Response(svg, { headers }))) } catch (_) { /* best effort */ }
  }
  return c.body(svg)
}

async function getBadge(c) {
  const cache = badgeCache()
  const key = cache ? badgeCacheKey(c) : null
  if (cache) {
    try {
      const hit = await cache.match(key)
      // Re-wrapped: a cached Response's headers can be immutable, and the
      // security-headers middleware still needs to add its own after us.
      if (hit) return new Response(hit.body, { status: hit.status, headers: hit.headers })
    } catch (_) { /* a cache hiccup is just a miss */ }
  }

  const ip = clientIp(c)
  if (!isTrustedPreview(c) && !(await rateLimiter.hitQuota(c.env, `rl:verifybadge:${rateKeyIp(ip, 48)}`, BADGE_IP_QUOTA, 15 * 60)))
    return c.json({ success: false, message: 'Too many requests.' }, 429, { 'Retry-After': '300' })

  const loaded = await loadByCode(c, { scope: 'badge', columns:
    'ats_score, fix_ats_score, verification_status, resume_ats_path, resume_hash, resume_pdf_path, resume_pdf_hash' })
  if (loaded.response) {
    // A genuine "no such page" is answered with a real (grey) badge and cached;
    // only a rate-limit (429) stays a plain error.
    if (loaded.notFound) return sendBadge(c, renderBadge('Passthrough', loaded.removed ? 'removed' : 'not found', '#6b7280'), BADGE_TTL_SECONDS, cache, key)
    return loaded.response
  }
  const { row } = loaded

  let value, color, ttl = BADGE_TTL_SECONDS
  if (row.verification_status === STATUS.REVOKED) { value = 'revoked'; color = '#6b7280' }
  else {
    const score = row.fix_ats_score ?? row.ats_score
    const passed = score != null && score >= constants.ATS_BADGE_THRESHOLD
    // Only pay for the integrity check when the score alone could otherwise
    // earn the "Verified" claim — a below-threshold scan is never going to
    // say "Verified" regardless of integrity, so there's nothing to check.
    const integrity = passed ? await checkIntegrity(c.env, row) : null
    if (integrity === 'unknown') ttl = BADGE_UNSETTLED_TTL_SECONDS
    if (passed && integrity === 'verified') { value = `${Math.round(score)}/100`; color = '#15803d' }
    else { value = score != null ? `scan ${Math.round(score)}/100` : 'scan report'; color = '#b45309' }
  }
  const label = value === 'revoked' || String(value).startsWith('scan') ? 'Passthrough' : 'Passthrough Verified'
  return sendBadge(c, renderBadge(label, value, color), ttl, cache, key)
}

module.exports = { getVerification, downloadVerifiedFile, getBadge, lookupByHash, renderBadge }
