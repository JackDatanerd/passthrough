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
      raw_brain_dump_text:  brainDumpText.slice(0, c.MAX_RESUME_CHARS)
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
      return ctx.json({ success: false, message: 'Daily scan limit reached. Upgrade for unlimited.' }, 429)
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
      await supabase.from('users').update({ scans_today: scansToday }).eq('id', user.id).catch(() => {})
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
        const parsed = JSON.parse(aiResult.data)
        if (typeof parsed.aiScore === 'number')
          finalScore = Math.round(
            (ruleResult.score * c.ATS_RULE_WEIGHT) + (parsed.aiScore * c.ATS_AI_WEIGHT)
          )
      } catch (_) {}
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
        fn(env, supabase, user.email, user.name, finalScore, {
          keywordScore:  ruleResult.keywordScore,
          formatScore:   ruleResult.formatScore,
          sectionsScore: ruleResult.sectionsScore,
          contentScore:  ruleResult.contentScore
        }).catch(e => console.error('Scan email:', e.message))
      }
    }
  } catch (err) {
    console.error('runAtsScan error:', err.message)
    await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId).catch(() => {})
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

    const jdText = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const candidateFirstName = (resumeData.name || '').split(' ')[0] || 'Candidate'
    const rewriteResult = await claudeService.rewriteResumeContent(env, resumeData, jdText)
    const finalData = rewriteResult.success ? rewriteResult.data : resumeData
    // PHASE 3: only meaningful if the rewrite actually succeeded — a failed
    // rewrite falls back to the original content, and there's nothing to
    // suggest strengthening in text that was never rewritten.
    const quantificationPrompts = rewriteResult.success
      ? (rewriteResult.quantificationOpportunities || [])
      : []

    const code            = await badgeService.generateShortCode(supabase)
    const verificationUrl = badgeService.buildVerificationUrl(env, code)

    // Pass verificationUrl to docxService — no hardcoded domain
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

    if (user)
      emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl)
        .catch(e => console.error('Fix email:', e.message))
  } catch (err) {
    console.error(`[CRITICAL] generateFix ${scanId}:`, err.message)
    await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId).catch(() => {})
    try {
      const { user } = await getScanWithUser(supabase, scanId)
      if (user) emailService.sendFixFailed(env, supabase, user.email, user.name).catch(() => {})
    } catch (_) {}
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

    if (user)
      emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl)
        .catch(e => console.error('Badge email:', e.message))
  } catch (err) {
    console.error(`[CRITICAL] generateBadge ${scanId}:`, err.message)
    await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId).catch(() => {})
    try {
      const { user } = await getScanWithUser(supabase, scanId)
      if (user) emailService.sendFixFailed(env, supabase, user.email, user.name).catch(() => {})
    } catch (_) {}
  }
}

module.exports = {
  createScan, getScanStatus, getScan, initiateFix, downloadFile, getScanHistory,
  runAtsScan, generateFix, generateBadge  // exported for webhook + payments + cron
}
