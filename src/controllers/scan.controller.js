// Ported from Express/Prisma/disk to Hono/Supabase/R2. The single most
// important change in this file is structural, not mechanical: every
// "respond now, finish work later" call site (createScan, and — in
// payments.controller.js / webhooks.controller.js — verifyPayment and the
// Paystack webhook) now wraps its background call in
// c.executionCtx.waitUntil(...) BEFORE returning the response. Per Section 3
// of the migration patch: a bare unawaited promise can be torn down mid-flight
// when the Workers isolate recycles right after the response returns. This is
// not optional anywhere it appears.
//
// runAtsScan / generateFix / generateBadge are no longer closures over a
// shared Prisma singleton — they take (env, supabase, scanId) explicitly,
// since payments.controller.js and webhooks.controller.js call them from a
// different request context than the one that created the scan.
//
// Both bugs found and fixed in a previous session are preserved exactly:
//   - PDF generation is wrapped in its own try/catch in both generateFix and
//     generateBadge, so a Browser Rendering failure delivers the DOCX alone
//     instead of erroring out a fix the user already paid for.
//   - The daily scan quota (scansToday) rolls back if the scan row fails to
//     insert after being incremented (the "Patch 5" rollback) — and this port
//     extends the same rollback to the R2 object, which didn't exist as a
//     concept in the original disk-based version.
//
// PHASE 1 (brain-dump entry path) additions, all clearly marked below:
//   - createScan now accepts EITHER an uploaded file OR pasted brain-dump
//     text — exactly one of the two, never both, never neither.
//   - runAtsScan branches on scan.inputMode: file-mode extracts text from
//     R2 as before; brain-dump mode structures the raw text via Claude and
//     deterministically serializes it back to plain text so the same
//     rule-based ats.service.js scorer runs unchanged against both.
//   - generateFix/generateBadge branch the same way when sourcing resumeData:
//     file-mode re-parses from R2 (unchanged); brain-dump mode reuses the
//     structured data already persisted by runAtsScan rather than paying for
//     a second, potentially-inconsistent structuring call.

const { z } = require('zod')
const c             = require('../config/constants')
const storage        = require('../config/storage')
const { getSupabase } = require('../config/supabase')
const cryptoLib       = require('../lib/crypto')
const { scanRowToCamel, userRowToCamel } = require('../lib/mappers')
const atsService    = require('../services/ats.service')
const claudeService  = require('../services/claude.service')
const resumeParser   = require('../services/resume.parser')
const jdParser        = require('../services/jd.parser')
const designService   = require('../services/design.service')
const badgeService     = require('../services/badge.service')
const pdfService        = require('../services/pdf.service')
const docxService        = require('../services/docx.service')
const emailService        = require('../services/email.service')
const rateLimiter          = require('../middleware/rateLimiter')

function extOf(filename) {
  const i = filename.lastIndexOf('.')
  return i === -1 ? '' : filename.slice(i).toLowerCase()
}

// POST /api/scan  — body already parsed by middleware/upload.js into
// c.get('uploadedFile') and c.get('formFields')
async function createScan(ctx) {
  const file   = ctx.get('uploadedFile')
  const fields = ctx.get('formFields') || {}
  const brainDumpText = (fields.brainDumpText || '').trim()
  // PHASE 4: third entry mode — reuse a previously saved profile instead of
  // uploading a file or pasting a fresh brain dump. Only meaningful for a
  // logged-in user (anonymous visitors have no account to have saved a
  // profile to), enforced explicitly below rather than left to fail
  // confusingly further down.
  const useSavedProfile = fields.useSavedProfile === 'true'

  const user = ctx.get('user')

  // PHASE 1 (extended in PHASE 4): exactly one of the three input modes
  // must be present. More than one present is rejected explicitly rather
  // than silently preferring one, so a frontend bug that sends two never
  // produces surprising behavior.
  const modesPresent = [!!file, !!brainDumpText, useSavedProfile].filter(Boolean).length
  if (modesPresent === 0)
    return ctx.json({ success: false,
      message: 'Upload a resume, tell us about your background, or use your saved profile.' }, 400)
  if (modesPresent > 1)
    return ctx.json({ success: false,
      message: 'Choose one: a resume file, your background, or your saved profile — not more than one.' }, 400)
  if (useSavedProfile && !user)
    return ctx.json({ success: false, message: 'Sign in to use a saved profile.' }, 401)

  const supabase = getSupabase(ctx.env)

  // R2 object key generated up front since the R2 key embeds the scan ID,
  // and we need that ID before the DB row exists. Generated client-side
  // with crypto.randomUUID() and inserted explicitly as the row's `id` —
  // not left to the DB's gen_random_uuid() default.
  const scanId = cryptoLib.uuid()

  // PHASE 1: only file-mode has an R2 key at all — brain-dump text and
  // saved-profile data are stored directly on the scans row, never R2.
  const resumeKey = file ? storage.resumeKey(scanId, extOf(file.originalname)) : null

  // PATCH 2 (carried over): clean up the R2 object on every validation
  // failure that fires after the file has already been written. Naturally
  // a no-op in brain-dump / saved-profile mode since `uploaded` never
  // flips true there.
  let uploaded = false
  async function cleanupFile() {
    if (uploaded) await ctx.env.RESUMES_BUCKET.delete(resumeKey).catch(() => {})
  }

  let jdText = (fields.jobDescriptionText || '').trim()

  if (fields.jobDescriptionUrl) {
    const fetched = await jdParser.fetchJobDescriptionFromUrl(fields.jobDescriptionUrl)
    if (fetched.blocked) {
      return ctx.json({ success: false, blocked: true, message: fetched.message }, 400)
    }
    if (fetched.success) jdText = fetched.text
    else if (!jdText) {
      return ctx.json({ success: false, message: fetched.message }, 400)
    }
  }

  jdText = jdText.slice(0, c.MAX_JD_CHARS)
  if (jdText.length < 50) {
    return ctx.json({ success: false, message: 'Job description too short (min 50 chars).' }, 400)
  }

  // PHASE 1: brain-dump minimum length, mirrors the JD length gate above.
  // File-mode has no equivalent check here — file content length is
  // validated later, after extraction, inside runAtsScan (same as before
  // this phase — that check hasn't moved).
  if (brainDumpText && brainDumpText.length < c.MIN_BRAIN_DUMP_CHARS) {
    return ctx.json({ success: false,
      message: `Tell us a bit more about your background (min ${c.MIN_BRAIN_DUMP_CHARS} chars).` }, 400)
  }

  // Anonymous brain-dump submissions collect name/email as explicit form
  // fields (logged-in users instead get a server-side fallback to their
  // account name/email — see runAtsScan). Folding them in as an explicit,
  // trivially-parseable preamble here — rather than adding new columns and
  // overriding resumeData after the fact — means Claude's own extraction
  // just reliably picks them up like any other stated fact, instead of
  // depending on someone happening to mention their own name while
  // describing their career (which people rarely do unprompted).
  const contactName  = (fields.contactName  || '').trim()
  const contactEmail = (fields.contactEmail || '').trim()
  const brainDumpWithContact = (!user && brainDumpText && (contactName || contactEmail))
    ? `Name: ${contactName}\nEmail: ${contactEmail}\n\n${brainDumpText}`
    : brainDumpText

  // PHASE 4: fetch the saved profile fresh from the DB — never trust a
  // client-supplied resumeData payload here, even implicitly. This is the
  // only place saved-profile data enters a new scan, and it always comes
  // from the user's own previously-saved (server-validated) record.
  let savedProfileData = null
  if (useSavedProfile) {
    const { data: userRow, error: profErr } = await supabase
      .from('users').select('saved_profile').eq('id', user.id).single()
    if (profErr) throw profErr
    savedProfileData = userRow.saved_profile?.resumeData || null
    if (!savedProfileData)
      return ctx.json({ success: false,
        message: 'No saved profile found. Upload a resume or paste your background instead.' }, 400)
  }

  // Fields shared by both input modes.
  function baseInsertFields() {
    return {
      id: scanId,
      job_description_text: jdText,
      job_description_url:  fields.jobDescriptionUrl || null,
    }
  }

  // Fields that differ by input mode, isolated here so both the logged-in
  // and anonymous branches below build an identical row shape.
  function modeInsertFields() {
    if (file) {
      return {
        input_mode:            'file',
        resume_path:           resumeKey,
        resume_original_name:  file.originalname,
        resume_mime_type:      file.mimetype
      }
    }
    if (useSavedProfile) {
      // Structured data is already available — no file, no structuring
      // Claude call needed at all. Populated immediately at creation time
      // so runAtsScan can skip straight to serialization + scoring.
      return {
        input_mode:            'saved_profile',
        original_resume_data:  savedProfileData
      }
    }
    return {
      input_mode:           'brain_dump',
      raw_brain_dump_text:  brainDumpWithContact.slice(0, c.MAX_RESUME_CHARS)
    }
  }

  async function putFileIfNeeded() {
    if (!file) return
    await ctx.env.RESUMES_BUCKET.put(resumeKey, file.bytes, { httpMetadata: { contentType: file.mimetype } })
    uploaded = true
  }

  if (user) {
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)
    const { data: freshRow, error: freshErr } = await supabase
      .from('users').select('scans_today, scans_day_reset').eq('id', user.id).single()
    if (freshErr) throw freshErr
    let scansToday = freshRow.scans_today

    if (new Date(freshRow.scans_day_reset) < todayMidnight) {
      await supabase.from('users').update({ scans_today: 0, scans_day_reset: new Date().toISOString() }).eq('id', user.id)
      scansToday = 0
    }
    if (scansToday >= c.FREE_SCANS_PER_DAY) {
      const ip = ctx.req.header('cf-connecting-ip') || ctx.req.header('x-forwarded-for') || 'unknown'
      // Same RATE_LIMIT_BYPASS_IPS secret used by middleware/rateLimiter.js —
      // this is a separate DB-tracked limit (not KV-based), but reuses the
      // same testing toggle so there's one bypass to turn on/off, not two.
      if (!rateLimiter.isBypassed(ctx.env, ip)) {
        return ctx.json({ success: false, message: 'Daily scan limit reached. Upgrade for unlimited.' }, 429)
      }
    }

    // PATCH 5 (carried over): increment optimistically, roll back on failure.
    await supabase.from('users').update({ scans_today: scansToday + 1 }).eq('id', user.id)

    try {
      await putFileIfNeeded()

      const { error: insertErr } = await supabase.from('scans').insert({
        ...baseInsertFields(),
        ...modeInsertFields(),
        user_id:         user.id,
        anon_token:      null,
        anon_expires_at: null
      })
      if (insertErr) throw insertErr
    } catch (createErr) {
      // Return the slot — scan was not created
      // NOTE: supabase-js query builders are thenable (have .then) but are not
      // real Promise instances, so .catch() doesn't exist on them directly —
      // must go through a real try/catch (or await) instead.
      try {
        await supabase.from('users').update({ scans_today: scansToday }).eq('id', user.id)
      } catch (_) {}
      await cleanupFile()
      throw createErr
    }

    ctx.executionCtx?.waitUntil(
      runAtsScan(ctx.env, supabase, scanId).catch(err => console.error('Unhandled runAtsScan:', err.message))
    )
    return ctx.json({ success: true, data: { scanId, anonToken: null } })
  }

  // Anonymous scan
  const anonToken = cryptoLib.uuid()
  try {
    await putFileIfNeeded()

    const { error: insertErr } = await supabase.from('scans').insert({
      ...baseInsertFields(),
      ...modeInsertFields(),
      user_id:          null,
      anon_token:        anonToken,
      anon_expires_at:   new Date(Date.now() + c.ANON_SCAN_TTL_HOURS * 3600000).toISOString()
    })
    if (insertErr) throw insertErr
  } catch (createErr) {
    await cleanupFile()
    throw createErr
  }

  ctx.executionCtx?.waitUntil(
    runAtsScan(ctx.env, supabase, scanId).catch(err => console.error('Unhandled runAtsScan:', err.message))
  )
  return ctx.json({ success: true, data: { scanId, anonToken } })
}

// GET /api/scan/status/:id
async function getScanStatus(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return ctx.json({ success: false, message: 'Not found.' }, 404)

  const user = ctx.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && scan.anonToken === ctx.req.query('token'))
  if (!isOwner) return ctx.json({ success: false, message: 'Access denied.' }, 403)

  // badgeEligible computed — NOT stored
  const badgeEligible = scan.atsScore != null ? scan.atsScore >= c.ATS_BADGE_THRESHOLD : null
  return ctx.json({ success: true, data: {
    status:        scan.status,
    atsScore:      scan.atsScore,
    passed:        scan.passed,
    badgeEligible,
    keywordScore:  scan.keywordScore,
    formatScore:   scan.formatScore,
    sectionsScore: scan.sectionsScore,
    contentScore:  scan.contentScore
  }})
}

// GET /api/scan/:id
async function getScan(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return ctx.json({ success: false, message: 'Not found.' }, 404)

  const user = ctx.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && scan.anonToken === ctx.req.query('token'))
  if (!isOwner) return ctx.json({ success: false, message: 'Access denied.' }, 403)

  const { fullAtsReport, resumePath, resumeAtsPath, resumePdfPath, ...safe } = scan
  const badgeEligible = scan.atsScore != null ? scan.atsScore >= c.ATS_BADGE_THRESHOLD : null
  return ctx.json({ success: true, data: { ...safe, badgeEligible } })
}

// POST /api/scan/:id/initiate-fix
async function initiateFix(ctx) {
  const user = ctx.get('user')
  const body = await ctx.req.json()
  const { fixTier } = z.object({ fixTier: z.enum(['FIX', 'BADGE']) }).parse(body)

  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return ctx.json({ success: false, message: 'Scan must be complete.' }, 400)
  if (scan.fixPurchased)
    return ctx.json({ success: false, message: 'Already purchased.' }, 400)
  if (fixTier === 'BADGE' && (scan.atsScore || 0) < c.ATS_BADGE_THRESHOLD)
    return ctx.json({ success: false, message: `Badge requires score >= ${c.ATS_BADGE_THRESHOLD}` }, 400)

  const amount = fixTier === 'BADGE' ? c.PRICE_BADGE : c.PRICE_FIX
  return ctx.json({ success: true, data: { amount, currency: c.CURRENCY, scanId: scan.id, fixTier } })
}

// POST /api/scan/:id/redeem-credit — use a free fix credit instead of
// paying. Mirrors the exact end-state payments.controller.js's
// verifyPayment produces (fix_purchased, status, fix_tier, enqueued job) so
// nothing downstream needs to know or care whether this fix was paid for
// or redeemed with a credit.
async function redeemCredit(ctx) {
  const user = ctx.get('user')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (scan.fixPurchased)
    return ctx.json({ success: false, message: 'Already purchased.' }, 400)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return ctx.json({ success: false, message: 'Scan must be complete.' }, 400)

  // Atomic conditional decrement (see 0006_redeem_fix_credit.sql) — avoids
  // a race between two concurrent redeem requests both seeing a stale
  // credit count > 0 and double-spending a single credit.
  const { data: redeemed, error: rpcErr } = await supabase.rpc('redeem_free_fix_credit', { p_user_id: user.id })
  if (rpcErr) throw rpcErr
  if (!redeemed)
    return ctx.json({ success: false, message: 'No free fix credits available.' }, 400)

  // Recorded as a $0 payment so payment history stays complete and
  // consistent — same shape as a real transaction, just free.
  await supabase.from('payments').insert({
    amount_cents: 0,
    currency:     ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
    status:       'SUCCESS',
    paystack_ref: `credit:${scan.id}:${Date.now()}`,
    user_id:      user.id,
    scan_id:      scan.id
  })

  await supabase.from('scans').update({
    fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: 'FIX'
  }).eq('id', scan.id)

  await ctx.env.FIX_QUEUE.send({ type: 'generateFix', scanId: scan.id })

  return ctx.json({ success: true, data: { scanId: scan.id } })
}

// POST /api/scan/:id/retry-fix — user-facing "Try Again" when a delivered
// fix fell short of ATS_BADGE_THRESHOLD. Re-runs generateFix, which (via
// the isRetry check inside it) builds on the latest rewrite rather than
// starting over, and carries forward feedback about what was weak.
async function retryFix(ctx) {
  const user = ctx.get('user')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (scan.fixTier !== 'FIX')
    return ctx.json({ success: false, message: 'Retries are only available for the Fix tier — Badge issues no rewrite, so there is nothing a retry would change.' }, 400)
  if (scan.status !== 'FIX_DELIVERED')
    return ctx.json({ success: false, message: 'This fix must finish generating before it can be retried.' }, 400)
  if (typeof scan.fixAtsScore === 'number' && scan.fixAtsScore >= c.ATS_BADGE_THRESHOLD)
    return ctx.json({ success: false, message: 'This fix already reached the target score — nothing to retry.' }, 400)
  if (scan.fixRetryCount >= c.MAX_FIX_RETRIES)
    return ctx.json({ success: false, message: 'No retries remaining for this fix.' }, 400)

  await supabase.from('scans').update({
    fix_retry_count: scan.fixRetryCount + 1,
    status: 'FIX_GENERATING'
  }).eq('id', scan.id)

  await ctx.env.FIX_QUEUE.send({ type: 'generateFix', scanId: scan.id })

  return ctx.json({ success: true, data: { retriesRemaining: c.MAX_FIX_RETRIES - (scan.fixRetryCount + 1) } })
}

// PATCH /api/scan/:id/verify-visibility — owner-only toggle for whether the
// actual .docx/PDF are publicly downloadable from this scan's verification
// page. Both default to false (0007_verify_document_visibility.sql) —
// purchasing a Fix/Badge opts into a public score page, not automatically
// into publishing the document content itself.
async function updateVerifyVisibility(ctx) {
  const user = ctx.get('user')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (!scan.verificationCode)
    return ctx.json({ success: false, message: 'This scan has no verification page yet.' }, 400)

  const body = await ctx.req.json().catch(() => ({}))
  const update = {}
  if (typeof body.exposeDocx === 'boolean') update.verify_expose_docx = body.exposeDocx
  if (typeof body.exposePdf  === 'boolean') update.verify_expose_pdf  = body.exposePdf
  if (Object.keys(update).length === 0)
    return ctx.json({ success: false, message: 'Nothing to update — expected exposeDocx and/or exposePdf as booleans.' }, 400)

  const { error: updateErr } = await supabase.from('scans').update(update).eq('id', scan.id)
  if (updateErr) throw updateErr

  return ctx.json({ success: true, data: {
    exposeDocx: update.verify_expose_docx ?? scan.verifyExposeDocx,
    exposePdf:  update.verify_expose_pdf  ?? scan.verifyExposePdf
  }})
}

// GET /api/scan/:id/download?type=ats|pdf
async function downloadFile(ctx) {
  const user = ctx.get('user')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (!scan.fixPurchased)
    return ctx.json({ success: false, message: 'Fix not purchased.' }, 403)
  if (!user.emailVerified)
    return ctx.json({ success: false, message: 'Verify your email to download.', code: 'EMAIL_NOT_VERIFIED' }, 403)

  const type     = ctx.req.query('type')
  const fileKey  = type === 'ats' ? scan.resumeAtsPath : scan.resumePdfPath
  const filename = type === 'ats' ? 'resume-ats.docx' : 'resume-verified.pdf'
  if (!fileKey) return ctx.json({ success: false, message: 'File not ready yet.' }, 404)

  const obj = await ctx.env.RESUMES_BUCKET.get(fileKey)
  if (!obj) return ctx.json({ success: false, message: 'File not ready yet.' }, 404)

  ctx.header('Content-Disposition', `attachment; filename="${filename}"`)
  ctx.header('Content-Type', type === 'ats'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/pdf')
  return ctx.body(obj.body)
}

// GET /api/scan/history?page=&limit=
async function getScanHistory(ctx) {
  const user = ctx.get('user')
  const page  = parseInt(ctx.req.query('page'))  || 1
  const limit = parseInt(ctx.req.query('limit')) || 10
  const from = (page - 1) * limit
  const to   = from + limit - 1

  const supabase = getSupabase(ctx.env)
  const { data: rows, error } = await supabase
    .from('scans')
    .select('id, status, ats_score, passed, resume_original_name, input_mode, created_at, fix_purchased, fix_tier, verification_code, keyword_score, format_score, sections_score, content_score')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, to)
  if (error) throw error

  const scans = rows.map(r => ({
    id: r.id, status: r.status, atsScore: r.ats_score, passed: r.passed,
    resumeOriginalName: r.resume_original_name, inputMode: r.input_mode, createdAt: r.created_at,
    fixPurchased: r.fix_purchased, fixTier: r.fix_tier, verificationCode: r.verification_code,
    keywordScore: r.keyword_score, formatScore: r.format_score,
    sectionsScore: r.sections_score, contentScore: r.content_score
  }))

  return ctx.json({ success: true, data: { scans, page, limit } })
}

// ─── helper: replaces Prisma's `include: { user: true }` ─────────────────
// Two simple queries instead of a Supabase embedded-resource select
// (`select('*, user:users(*)')`). The embedded-select syntax depends on
// PostgREST correctly resolving the scans.user_id -> users.id foreign key
// at the schema-cache level — this was flagged as unverified-at-scale in
// the migration patch (Section 10), so two plain queries are used instead:
// slightly more I/O, zero dependency on relationship auto-detection.
async function getScanWithUser(supabase, scanId) {
  const { data: scanRow, error: scanErr } = await supabase.from('scans').select('*').eq('id', scanId).maybeSingle()
  if (scanErr) throw scanErr
  const scan = scanRowToCamel(scanRow)
  if (!scan) return { scan: null, user: null }
  if (!scan.userId) return { scan, user: null }
  const { data: userRow, error: userErr } = await supabase.from('users').select('*').eq('id', scan.userId).maybeSingle()
  if (userErr) throw userErr
  return { scan, user: userRowToCamel(userRow) }
}

// ─── runAtsScan — file-mode: extractText only, no Claude, no cost on free
//     scans. brain-dump mode: structuring IS a Claude call (unavoidable —
//     there's no file to extract text from), still no cost on top of that
//     for scoring itself. ──────────────────────────────────────────────────

async function runAtsScan(env, supabase, scanId) {
  try {
    await supabase.from('scans').update({ status: 'SCANNING' }).eq('id', scanId)
    const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).single()
    if (error) throw error
    const scan = scanRowToCamel(row)

    let rawResumeText

    if (scan.inputMode === 'brain_dump') {
      // PHASE 1: no file to extract from — structure the raw pasted text
      // into the same resumeData shape parseResumeStructure produces for
      // uploaded resumes, then deterministically render it back to plain
      // text so ats.service.js's rule-based scorer runs unchanged.
      const { resumeData, parseError, parseErrorMessage } =
        await resumeParser.structureBrainDump(env, scan.rawBrainDumpText)
      if (parseError || !resumeData) {
        await supabase.from('scans').update({
          status: 'ERROR',
          full_ats_report: { error: parseErrorMessage || 'Could not structure background.' }
        }).eq('id', scanId)
        return
      }
      // People describing their own career rarely think to state their own
      // name or email — Claude is correctly instructed never to invent one
      // (see structureFreeformText's prompt), which means it's frequently
      // null. For a logged-in user, fall back to what's already on their
      // account rather than shipping a resume with a blank name line.
      // Doesn't help an ANONYMOUS brain-dump with no account to fall back
      // to — that case still needs either explicit name/email form fields
      // or clearer copy nudging the user to include them in the text.
      if (scan.userId && (!resumeData.name || !resumeData.email)) {
        const { data: userRow } = await supabase.from('users').select('name, email').eq('id', scan.userId).maybeSingle()
        if (userRow) {
          resumeData.name  = resumeData.name  || userRow.name
          resumeData.email = resumeData.email || userRow.email
        }
      }
      rawResumeText = resumeParser.serializeResumeData(resumeData)

      // Persist the structured data now. This is a functional requirement
      // for brain-dump mode specifically — generateFix/generateBadge need
      // this exact structured object later, and unlike file-mode there is
      // no R2 object to re-derive it from a second time. (Phase 2 will
      // additionally persist rewrittenResumeData, and do the equivalent
      // capture for file-mode scans, purely for the diff-view feature —
      // this write here is separate from that and would exist even if
      // Phase 2 never shipped.)
      await supabase.from('scans').update({ original_resume_data: resumeData }).eq('id', scanId)
    } else if (scan.inputMode === 'saved_profile') {
      // PHASE 4: structured data was already populated at scan-creation
      // time directly from users.saved_profile (see createScan) — no file,
      // no structuring Claude call needed at all here. Just serialize
      // straight to text for scoring, reusing the same deterministic
      // serializer brain-dump mode uses after its own structuring step.
      if (!scan.originalResumeData) {
        await supabase.from('scans').update({
          status: 'ERROR',
          full_ats_report: { error: 'Saved profile data missing.' }
        }).eq('id', scanId)
        return
      }
      rawResumeText = resumeParser.serializeResumeData(scan.originalResumeData)
    } else {
      const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
      if (!obj) throw new Error('Resume file missing from storage')
      const bytes = new Uint8Array(await obj.arrayBuffer())
      rawResumeText = await resumeParser.extractText(bytes, scan.resumeMimeType)
    }

    if (!rawResumeText || rawResumeText.trim().length < 100) {
      await supabase.from('scans').update({
        status: 'ERROR', full_ats_report: { error: 'Resume could not be parsed.' }
      }).eq('id', scanId)
      return
    }

    const resumeText = rawResumeText.slice(0, c.MAX_RESUME_CHARS)
    const jdText     = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const ruleResult = atsService.scoreResume(resumeText, jdText)

    // AI blend — 70% rule + 30% AI, never fail scan if AI unavailable
    let finalScore = ruleResult.score
    const aiResult = await claudeService.scoreResumeWithAI(env, resumeText, jdText)
    if (aiResult.success) {
      try {
        const parsed = claudeService.extractJson(aiResult.data)
        if (typeof parsed.aiScore === 'number')
          finalScore = Math.round(
            (ruleResult.score * c.ATS_RULE_WEIGHT) + (parsed.aiScore * c.ATS_AI_WEIGHT)
          )
      } catch (parseErr) {
        // Non-fatal by design — falls back to rule-only score — but log it
        // so a silent AI-scoring degradation is at least visible in tail.
        console.error('AI score parse failed, using rule-only score:', parseErr.message)
      }
    }
    finalScore = Math.max(0, Math.min(100, finalScore))

    await supabase.from('scans').update({
      ats_score:       finalScore,
      passed:          finalScore >= c.ATS_PASS_THRESHOLD,
      keyword_score:   ruleResult.keywordScore,
      format_score:    ruleResult.formatScore,
      sections_score:  ruleResult.sectionsScore,
      content_score:   ruleResult.contentScore,
      full_ats_report: ruleResult.detail,
      role_category:   atsService.detectRoleCategory(jdText),
      seniority_level: atsService.detectSeniority(jdText),
      scan_completed_at: new Date().toISOString(),
      status: finalScore >= c.ATS_PASS_THRESHOLD ? 'COMPLETE_PASS' : 'COMPLETE_FAIL'
    }).eq('id', scanId)

    if (scan.userId) {
      const { data: userRow } = await supabase.from('users').select('*').eq('id', scan.userId).maybeSingle()
      const user = userRowToCamel(userRow)
      if (user) {
        const fn = finalScore >= c.ATS_PASS_THRESHOLD ? emailService.sendScanPass : emailService.sendScanFail
        // Awaited rather than fire-and-forget: this whole function already
        // runs inside a background waitUntil() call from createScan (the
        // HTTP response already returned), so there's no response to delay
        // — but an un-awaited promise here can still get silently cancelled
        // when runAtsScan itself resolves, since waitUntil only protects
        // the promise passed to it, not promises nested further inside.
        try {
          await fn(env, supabase, user.email, user.name, finalScore, {
            keywordScore:  ruleResult.keywordScore,
            formatScore:   ruleResult.formatScore,
            sectionsScore: ruleResult.sectionsScore,
            contentScore:  ruleResult.contentScore
          })
        } catch (e) { console.error('Scan email:', e.message) }
      }
    }
  } catch (err) {
    console.error('runAtsScan error:', err.message)
    // supabase-js query builders are thenable but not real Promises — .catch()
    // doesn't exist on them directly, must use a real try/catch instead.
    try {
      await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId)
    } catch (_) {}
  }
}

// ─── generateFix — AI rewrite + ATS DOCX + beautiful PDF + credential ────────

async function generateFix(env, supabase, scanId) {
  try {
    await supabase.from('scans').update({ status: 'FIX_GENERATING' }).eq('id', scanId)
    const { scan, user } = await getScanWithUser(supabase, scanId)

    let resumeData

    if (scan.inputMode === 'brain_dump' || scan.inputMode === 'saved_profile') {
      // PHASE 1 (brain_dump) / PHASE 4 (saved_profile): both non-file modes
      // reuse structured data already persisted on the scan row rather
      // than re-deriving it — cheaper, and guarantees the fix rewrites
      // from the exact same structured object that was scored. The two
      // modes differ only in HOW that data got there (a structuring Claude
      // call vs a direct copy from users.saved_profile); by this point the
      // sourcing logic is identical either way.
      resumeData = scan.originalResumeData
      if (!resumeData)
        throw new Error(`${scan.inputMode} scan has no structured data — runAtsScan did not complete successfully`)
    } else {
      const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
      if (!obj) throw new Error('Resume file missing from storage')
      const resumeBytes = new Uint8Array(await obj.arrayBuffer())

      const parsed = await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)
      if (parsed.parseError || !parsed.resumeData) throw new Error(parsed.parseErrorMessage || 'Parse failed')
      resumeData = parsed.resumeData
    }

    // Retries build on the LATEST delivered rewrite, not the original
    // upload — this is what "each retry uses the latest generated resume
    // plus feedback" means in practice. isRetry is just "has this scan's
    // retry counter already been incremented past 0" (see retryFix below,
    // which increments it before enqueueing).
    const isRetry = scan.fixRetryCount > 0
    if (isRetry && scan.rewrittenResumeData) resumeData = scan.rewrittenResumeData

    const jdText = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const candidateFirstName = (resumeData.name || '').split(' ')[0] || 'Candidate'
    const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    // Verification code/URL computed BEFORE the loop now (was previously
    // computed after) — every candidate's scoring docx and the final
    // delivered docx need to embed the exact same URL, both so scoring is
    // consistent with what's actually delivered, and so retries continue
    // reusing the existing link (see comment below) rather than orphaning
    // it partway through a round.
    const code            = isRetry && scan.verificationCode ? scan.verificationCode : await badgeService.generateShortCode(supabase)
    const verificationUrl = isRetry && scan.verificationUrl  ? scan.verificationUrl  : badgeService.buildVerificationUrl(env, code)

    // Rewrite → score → retry-with-feedback loop. A rewrite that "succeeds"
    // (valid JSON, no fabrication) isn't the same as a rewrite that's
    // actually good — this was previously trusted blindly, which is how a
    // resume could come out of "Fix My Resume" scoring worse than it went
    // in.
    //
    // WYSIWYG scoring: each candidate is scored by generating the ACTUAL
    // docx and extracting its real text — not resumeParser.serializeResumeData()'s
    // synthetic approximation. That synthetic text was confirmed (by a real
    // user report) to score measurably WORSE than the real generated file
    // scored on a fresh re-upload — same content, different number, purely
    // because of how the two paths render the same structured data. Scoring
    // the real file eliminates that discrepancy at the source rather than
    // leaving the retry loop chasing a distorted number.
    let finalData = resumeData
    let finalDocxBytes = null
    let quantificationPrompts = []
    // On a retry round, seed the "best so far" with what was ALREADY
    // delivered (scan.fixAtsScore) rather than -1 — without this, a retry
    // round where every new attempt happens to score worse than the
    // previous round's result would still overwrite it, silently
    // regressing a score the user already has. A retry should only ever
    // replace the delivered resume with something strictly better.
    let bestScore = isRetry && typeof scan.fixAtsScore === 'number' ? scan.fixAtsScore : -1
    let bestData = resumeData
    let bestDocxBytes = null
    let bestQuantificationPrompts = isRetry ? (scan.quantificationPrompts || []) : []
    // On a retry round, the first attempt should already know WHY the
    // previous round's best result fell short, instead of blindly
    // re-attempting from a cold start. Re-score the starting point fresh
    // here (cheap — one docx generation + extraction, no Claude call) purely
    // to regenerate that weak-areas detail — fix_ats_score alone doesn't
    // carry enough information to build it.
    let lastFeedback = null
    if (isRetry && typeof scan.fixAtsScore === 'number') {
      const startingDocxBytes = await docxService.generateAtsDocx(resumeData, verificationUrl)
      const startingText = await resumeParser.extractText(startingDocxBytes, DOCX_MIME)
      const startingScore = atsService.scoreResume(startingText, jdText)
      lastFeedback = {
        score: scan.fixAtsScore,
        threshold: c.ATS_BADGE_THRESHOLD,
        weakAreas: atsService.describeWeakAreas(startingScore)
      }
    }

    for (let attempt = 1; attempt <= c.MAX_FIX_ATTEMPTS; attempt++) {
      const rewriteResult = await claudeService.rewriteResumeContent(env, resumeData, jdText, lastFeedback)
      if (!rewriteResult.success) break  // API/parse failure — nothing to score, stop retrying

      const candidateData = rewriteResult.data
      const candidateQuantificationPrompts = rewriteResult.quantificationOpportunities || []
      // Score the REAL generated file, not a synthetic text approximation —
      // see the WYSIWYG comment above.
      const candidateDocxBytes = await docxService.generateAtsDocx(candidateData, verificationUrl)
      const candidateText = await resumeParser.extractText(candidateDocxBytes, DOCX_MIME)
      const candidateScore = atsService.scoreResume(candidateText, jdText)

      if (candidateScore.score > bestScore) {
        bestScore = candidateScore.score
        bestData = candidateData
        bestDocxBytes = candidateDocxBytes
        bestQuantificationPrompts = candidateQuantificationPrompts
      }

      if (candidateScore.score >= c.ATS_BADGE_THRESHOLD) break  // good enough — stop here

      if (attempt < c.MAX_FIX_ATTEMPTS) {
        lastFeedback = {
          score: candidateScore.score,
          threshold: c.ATS_BADGE_THRESHOLD,
          weakAreas: atsService.describeWeakAreas(candidateScore)
        }
      }
    }

    finalData = bestData
    quantificationPrompts = bestQuantificationPrompts
    // bestScore stays -1 only if every attempt failed at the API/parse level
    // (never even produced a scoreable candidate) — fall back to scoring the
    // untouched original so fix_ats_score is never left null on a delivered
    // scan. Uses the same WYSIWYG approach as the main loop for consistency.
    const fixAtsScore = bestScore >= 0
      ? bestScore
      : atsService.scoreResume(
          await resumeParser.extractText(await docxService.generateAtsDocx(resumeData, verificationUrl), DOCX_MIME),
          jdText
        ).score

    // Retries are exhausted (this was the last one allowed) and still
    // short of the badge threshold — grant a free credit for next time
    // rather than leaving the user with nothing to show for it.
    if (isRetry && scan.fixRetryCount >= c.MAX_FIX_RETRIES && fixAtsScore < c.ATS_BADGE_THRESHOLD && scan.userId) {
      try {
        await supabase.rpc('increment_free_fix_credits', { p_user_id: scan.userId })
      } catch (creditErr) {
        console.error(`Failed to grant fix credit to ${scan.userId}:`, creditErr.message)
      }
    }

    // Reuse the winning attempt's already-generated docx bytes instead of
    // generating a 4th time — bestDocxBytes is set whenever a NEW attempt in
    // THIS round beats the running best. The one case it's still null: a
    // retry round where every new attempt scored worse than the carried-
    // forward previous-round result, so bestData never changed from its
    // initial value and there's nothing new to reuse — regenerate in that
    // one case only.
    const docxBytes = bestDocxBytes || await docxService.generateAtsDocx(finalData, verificationUrl)
    const docxKey   = storage.atsDocxKey(scanId)
    await env.RESUMES_BUCKET.put(docxKey, docxBytes, {
      httpMetadata: { contentType: DOCX_MIME }
    })
    const resumeHash = await badgeService.hashBytes(docxBytes)

    const designTokens = designService.getDesignTokens(scan.userId || scanId, scanId, scan.roleCategory)
    let pdfKey = null
    const htmlResult = await claudeService.generateBeautifulResumeHTML(env, finalData, designTokens, verificationUrl)
    if (htmlResult.success) {
      try {
        const pdfBytes = await pdfService.generateResumePDF(env, htmlResult.data)
        pdfKey = storage.beautifulPdfKey(scanId)
        await env.RESUMES_BUCKET.put(pdfKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } })
      } catch (pdfErr) {
        // PDF failure must not kill delivery — DOCX is already generated and paid for
        console.error(`[WARN] PDF generation failed for ${scanId}:`, pdfErr.message)
        pdfKey = null
      }
    }

    await supabase.from('scans').update({
      candidate_first_name: candidateFirstName,
      resume_ats_path:      docxKey,
      resume_pdf_path:      pdfKey,
      fix_ats_score:        fixAtsScore,
      fix_generated_at:     new Date().toISOString(),
      verification_code:    code,
      verification_url:     verificationUrl,
      resume_hash:           resumeHash,
      verified_at:            new Date().toISOString(),
      // PHASE 2: persist both structured objects for the diff view.
      // resumeData is what the resume WAS (already parsed above, from R2 for
      // file-mode or scan.originalResumeData for brain-dump mode) — writing
      // it here is a no-op for brain-dump mode (already persisted by
      // runAtsScan) and the first persistence for file-mode. finalData is
      // what the AI rewrite produced, OR equals resumeData unchanged if the
      // rewrite failed and generateFix fell back to the original content —
      // in that fallback case the two objects are identical and the diff
      // view will correctly render "no changes," which is the honest signal.
      original_resume_data:  resumeData,
      rewritten_resume_data: finalData,
      // PHASE 3: static suggestions only — no regeneration loop in v1. See
      // QuantificationPrompts.jsx for how these render.
      quantification_prompts: quantificationPrompts,
      status: 'FIX_DELIVERED'
    }).eq('id', scanId)

    if (user) {
      try {
        await emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl)
      } catch (e) { console.error('Fix email:', e.message) }
    }
    return { success: true }
  } catch (err) {
    console.error(`[CRITICAL] generateFix ${scanId}:`, err.message)
    try {
      await emailService.sendOwnerAlert(env,
        'generateFix crashed',
        `scanId: ${scanId}\nerror: ${err.message}\nstack: ${err.stack || '(none)'}`
      )
    } catch (_) {}
    // supabase-js query builders are thenable but not real Promises — .catch()
    // doesn't exist on them directly, must use a real try/catch instead.
    try {
      await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId)
    } catch (_) {}
    try {
      const { user } = await getScanWithUser(supabase, scanId)
      if (user) await emailService.sendFixFailed(env, supabase, user.email, user.name)
    } catch (_) {}
    // Explicit failure signal — without this, the function resolves either
    // way (success or internally-handled failure), and a caller like the
    // queue consumer can't tell the difference from the promise alone.
    return { success: false, error: err.message }
  }
}

// ─── generateBadge — no AI rewrite, original content, parse fallback ────────

async function generateBadge(env, supabase, scanId) {
  try {
    await supabase.from('scans').update({ status: 'FIX_GENERATING' }).eq('id', scanId)
    const { scan, user } = await getScanWithUser(supabase, scanId)

    let finalData

    if (scan.inputMode === 'brain_dump' || scan.inputMode === 'saved_profile') {
      // PHASE 1 (brain_dump) / PHASE 4 (saved_profile): same source as
      // generateFix above. Falls back to an empty shell rather than
      // throwing if something upstream went wrong — badge generation must
      // never crash, same guarantee file-mode has via its parse-fallback
      // branch below.
      finalData = scan.originalResumeData
      if (!finalData) {
        finalData = {
          name: 'Candidate', email: '', phone: null, location: null, summary: null,
          experience: [], education: [], skills: [], certifications: []
        }
        console.warn(`generateBadge: missing originalResumeData for ${scan.inputMode} scan ${scanId}`)
      }
    } else {
      const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
      if (!obj) throw new Error('Resume file missing from storage')
      const resumeBytes = new Uint8Array(await obj.arrayBuffer())

      const { resumeData, parseError } = await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)

      // Parse fallback — badge cannot crash if Claude parse fails
      if (parseError || !resumeData) {
        const rawText = await resumeParser.extractText(resumeBytes, scan.resumeMimeType)
        finalData = {
          name: 'Candidate', email: '', phone: null, location: null, summary: null,
          experience: [], education: [],
          skills: rawText.slice(0, 500).split(/\s+/).slice(0, 20),
          certifications: []
        }
        console.warn(`generateBadge: parse fallback for ${scanId}`)
      } else {
        finalData = resumeData
      }
    }

    // Use finalData.name — correct source after fallback
    const candidateFirstName = (finalData.name || '').split(' ')[0] || 'Candidate'
    const code            = await badgeService.generateShortCode(supabase)
    const verificationUrl = badgeService.buildVerificationUrl(env, code)

    // Pass verificationUrl — not hardcoded domain
    const docxBytes = await docxService.generateAtsDocx(finalData, verificationUrl)
    const docxKey   = storage.atsDocxKey(scanId)
    await env.RESUMES_BUCKET.put(docxKey, docxBytes, {
      httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    })
    const resumeHash = await badgeService.hashBytes(docxBytes)

    const designTokens = designService.getDesignTokens(scan.userId || scanId, scanId, scan.roleCategory)
    let pdfKey = null
    const htmlResult = await claudeService.generateBeautifulResumeHTML(env, finalData, designTokens, verificationUrl)
    if (htmlResult.success) {
      try {
        const pdfBytes = await pdfService.generateResumePDF(env, htmlResult.data)
        pdfKey = storage.beautifulPdfKey(scanId)
        await env.RESUMES_BUCKET.put(pdfKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } })
      } catch (pdfErr) {
        // PDF failure must not kill delivery — DOCX is already generated and paid for
        console.error(`[WARN] PDF generation failed for ${scanId}:`, pdfErr.message)
        pdfKey = null
      }
    }

    await supabase.from('scans').update({
      candidate_first_name: candidateFirstName,
      resume_ats_path:      docxKey,
      resume_pdf_path:      pdfKey,
      fix_ats_score:        scan.atsScore,
      fix_generated_at:     new Date().toISOString(),
      verification_code:    code,
      verification_url:     verificationUrl,
      resume_hash:           resumeHash,
      verified_at:            new Date().toISOString(),
      // PHASE 2: persist the structured content for the diff view. Note the
      // naming here — `finalData` in this function is the ORIGINAL content
      // (possibly the parse-fallback shell), never a rewrite: generateBadge
      // never calls rewriteResumeContent, by design, since badge-only
      // purchases don't include the AI rewrite. rewritten_resume_data is
      // deliberately left untouched (stays null) — DiffView.jsx uses that
      // null to render "credential only, no content changes" instead of a
      // diff that would misleadingly imply a rewrite happened.
      original_resume_data:  finalData,
      status: 'FIX_DELIVERED'
    }).eq('id', scanId)

    if (user) {
      try {
        await emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl)
      } catch (e) { console.error('Badge email:', e.message) }
    }
    return { success: true }
  } catch (err) {
    console.error(`[CRITICAL] generateBadge ${scanId}:`, err.message)
    try {
      await emailService.sendOwnerAlert(env,
        'generateBadge crashed',
        `scanId: ${scanId}\nerror: ${err.message}\nstack: ${err.stack || '(none)'}`
      )
    } catch (_) {}
    // supabase-js query builders are thenable but not real Promises — .catch()
    // doesn't exist on them directly, must use a real try/catch instead.
    try {
      await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId)
    } catch (_) {}
    try {
      const { user } = await getScanWithUser(supabase, scanId)
      if (user) await emailService.sendFixFailed(env, supabase, user.email, user.name)
    } catch (_) {}
    return { success: false, error: err.message }
  }
}

module.exports = {
  createScan, getScanStatus, getScan, initiateFix, redeemCredit, retryFix, updateVerifyVisibility, downloadFile, getScanHistory,
  runAtsScan, generateFix, generateBadge  // exported for webhook + payments + cron
}
