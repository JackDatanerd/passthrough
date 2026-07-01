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
// Both bugs found and fixed in the previous session are preserved exactly:
//   - PDF generation is wrapped in its own try/catch in both generateFix and
//     generateBadge, so a Browser Rendering failure delivers the DOCX alone
//     instead of erroring out a fix the user already paid for.
//   - The daily scan quota (scansToday) rolls back if the scan row fails to
//     insert after being incremented (the "Patch 5" rollback) — and this port
//     extends the same rollback to the R2 object, which didn't exist as a
//     concept in the original disk-based version.

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
async function createScan(c) {
  const file   = c.get('uploadedFile')
  const fields = c.get('formFields') || {}
  if (!file) return c.json({ success: false, message: 'Resume file is required.' }, 400)

  const supabase = getSupabase(c.env)
  const user = c.get('user')

  // R2 object key generated up front since the R2 key embeds the scan ID,
  // and we need that ID before the DB row exists. Generated client-side
  // with crypto.randomUUID() and inserted explicitly as the row's `id` —
  // not left to the DB's gen_random_uuid() default.
  const scanId = cryptoLib.uuid()
  const resumeKey = storage.resumeKey(scanId, extOf(file.originalname))

  // PATCH 2 (carried over): clean up the R2 object on every validation
  // failure that fires after the file has already been written.
  let uploaded = false
  async function cleanupFile() {
    if (uploaded) await c.env.RESUMES_BUCKET.delete(resumeKey).catch(() => {})
  }

  let jdText = (fields.jobDescriptionText || '').trim()

  if (fields.jobDescriptionUrl) {
    const fetched = await jdParser.fetchJobDescriptionFromUrl(fields.jobDescriptionUrl)
    if (fetched.blocked) {
      return c.json({ success: false, blocked: true, message: fetched.message }, 400)
    }
    if (fetched.success) jdText = fetched.text
    else if (!jdText) {
      return c.json({ success: false, message: fetched.message }, 400)
    }
  }

  jdText = jdText.slice(0, c.MAX_JD_CHARS)
  if (jdText.length < 50) {
    return c.json({ success: false, message: 'Job description too short (min 50 chars).' }, 400)
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
      return c.json({ success: false, message: 'Daily scan limit reached. Upgrade for unlimited.' }, 429)
    }

    // PATCH 5 (carried over): increment optimistically, roll back on failure.
    await supabase.from('users').update({ scans_today: scansToday + 1 }).eq('id', user.id)

    try {
      await c.env.RESUMES_BUCKET.put(resumeKey, file.bytes, { httpMetadata: { contentType: file.mimetype } })
      uploaded = true

      const { error: insertErr } = await supabase.from('scans').insert({
        id: scanId,
        resume_path:          resumeKey,
        resume_original_name: file.originalname,
        resume_mime_type:     file.mimetype,
        job_description_text: jdText,
        job_description_url:  fields.jobDescriptionUrl || null,
        user_id:               user.id,
        anon_token:             null,
        anon_expires_at:        null
      })
      if (insertErr) throw insertErr
    } catch (createErr) {
      // Return the slot — scan was not created
      await supabase.from('users').update({ scans_today: scansToday }).eq('id', user.id).catch(() => {})
      await cleanupFile()
      throw createErr
    }

    c.executionCtx?.waitUntil(
      runAtsScan(c.env, supabase, scanId).catch(err => console.error('Unhandled runAtsScan:', err.message))
    )
    return c.json({ success: true, data: { scanId, anonToken: null } })
  }

  // Anonymous scan
  const anonToken = cryptoLib.uuid()
  try {
    await c.env.RESUMES_BUCKET.put(resumeKey, file.bytes, { httpMetadata: { contentType: file.mimetype } })
    uploaded = true

    const { error: insertErr } = await supabase.from('scans').insert({
      id: scanId,
      resume_path:          resumeKey,
      resume_original_name: file.originalname,
      resume_mime_type:     file.mimetype,
      job_description_text: jdText,
      job_description_url:  fields.jobDescriptionUrl || null,
      user_id:                null,
      anon_token:              anonToken,
      anon_expires_at:         new Date(Date.now() + c.ANON_SCAN_TTL_HOURS * 3600000).toISOString()
    })
    if (insertErr) throw insertErr
  } catch (createErr) {
    await cleanupFile()
    throw createErr
  }

  c.executionCtx?.waitUntil(
    runAtsScan(c.env, supabase, scanId).catch(err => console.error('Unhandled runAtsScan:', err.message))
  )
  return c.json({ success: true, data: { scanId, anonToken } })
}

// GET /api/scan/status/:id
async function getScanStatus(c) {
  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return c.json({ success: false, message: 'Not found.' }, 404)

  const user = c.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && scan.anonToken === c.req.query('token'))
  if (!isOwner) return c.json({ success: false, message: 'Access denied.' }, 403)

  // badgeEligible computed — NOT stored
  const badgeEligible = scan.atsScore != null ? scan.atsScore >= c.ATS_BADGE_THRESHOLD : null
  return c.json({ success: true, data: {
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
async function getScan(c) {
  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return c.json({ success: false, message: 'Not found.' }, 404)

  const user = c.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && scan.anonToken === c.req.query('token'))
  if (!isOwner) return c.json({ success: false, message: 'Access denied.' }, 403)

  const { fullAtsReport, resumePath, resumeAtsPath, resumePdfPath, ...safe } = scan
  const badgeEligible = scan.atsScore != null ? scan.atsScore >= c.ATS_BADGE_THRESHOLD : null
  return c.json({ success: true, data: { ...safe, badgeEligible } })
}

// POST /api/scan/:id/initiate-fix
async function initiateFix(c) {
  const user = c.get('user')
  const body = await c.req.json()
  const { fixTier } = z.object({ fixTier: z.enum(['FIX', 'BADGE']) }).parse(body)

  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return c.json({ success: false, message: 'Access denied.' }, 403)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return c.json({ success: false, message: 'Scan must be complete.' }, 400)
  if (scan.fixPurchased)
    return c.json({ success: false, message: 'Already purchased.' }, 400)
  if (fixTier === 'BADGE' && (scan.atsScore || 0) < c.ATS_BADGE_THRESHOLD)
    return c.json({ success: false, message: `Badge requires score >= ${c.ATS_BADGE_THRESHOLD}` }, 400)

  const amount = fixTier === 'BADGE' ? c.PRICE_BADGE : c.PRICE_FIX
  return c.json({ success: true, data: { amount, currency: c.CURRENCY, scanId: scan.id, fixTier } })
}

// GET /api/scan/:id/download?type=ats|pdf
async function downloadFile(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return c.json({ success: false, message: 'Access denied.' }, 403)
  if (!scan.fixPurchased)
    return c.json({ success: false, message: 'Fix not purchased.' }, 403)
  if (!user.emailVerified)
    return c.json({ success: false, message: 'Verify your email to download.', code: 'EMAIL_NOT_VERIFIED' }, 403)

  const type     = c.req.query('type')
  const fileKey  = type === 'ats' ? scan.resumeAtsPath : scan.resumePdfPath
  const filename = type === 'ats' ? 'resume-ats.docx' : 'resume-verified.pdf'
  if (!fileKey) return c.json({ success: false, message: 'File not ready yet.' }, 404)

  const obj = await c.env.RESUMES_BUCKET.get(fileKey)
  if (!obj) return c.json({ success: false, message: 'File not ready yet.' }, 404)

  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', type === 'ats'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/pdf')
  return c.body(obj.body)
}

// GET /api/scan/history?page=&limit=
async function getScanHistory(c) {
  const user = c.get('user')
  const page  = parseInt(c.req.query('page'))  || 1
  const limit = parseInt(c.req.query('limit')) || 10
  const from = (page - 1) * limit
  const to   = from + limit - 1

  const supabase = getSupabase(c.env)
  const { data: rows, error } = await supabase
    .from('scans')
    .select('id, status, ats_score, passed, resume_original_name, created_at, fix_purchased, fix_tier, verification_code, keyword_score, format_score, sections_score, content_score')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(from, to)
  if (error) throw error

  const scans = rows.map(r => ({
    id: r.id, status: r.status, atsScore: r.ats_score, passed: r.passed,
    resumeOriginalName: r.resume_original_name, createdAt: r.created_at,
    fixPurchased: r.fix_purchased, fixTier: r.fix_tier, verificationCode: r.verification_code,
    keywordScore: r.keyword_score, formatScore: r.format_score,
    sectionsScore: r.sections_score, contentScore: r.content_score
  }))

  return c.json({ success: true, data: { scans, page, limit } })
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

// ─── runAtsScan — uses extractText ONLY, no Claude, no cost on free scans ────

async function runAtsScan(env, supabase, scanId) {
  try {
    await supabase.from('scans').update({ status: 'SCANNING' }).eq('id', scanId)
    const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).single()
    if (error) throw error
    const scan = scanRowToCamel(row)

    const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
    if (!obj) throw new Error('Resume file missing from storage')
    const bytes = new Uint8Array(await obj.arrayBuffer())

    const text = await resumeParser.extractText(bytes, scan.resumeMimeType)
    if (!text || text.trim().length < 100) {
      await supabase.from('scans').update({
        status: 'ERROR', full_ats_report: { error: 'Resume could not be parsed.' }
      }).eq('id', scanId)
      return
    }

    const resumeText = text.slice(0, c.MAX_RESUME_CHARS)
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

    const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
    if (!obj) throw new Error('Resume file missing from storage')
    const resumeBytes = new Uint8Array(await obj.arrayBuffer())

    const { resumeData, parseError, parseErrorMessage } =
      await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)
    if (parseError || !resumeData) throw new Error(parseErrorMessage || 'Parse failed')

    const jdText = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const candidateFirstName = (resumeData.name || '').split(' ')[0] || 'Candidate'
    const rewriteResult = await claudeService.rewriteResumeContent(env, resumeData, jdText)
    const finalData = rewriteResult.success ? rewriteResult.data : resumeData

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

    const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
    if (!obj) throw new Error('Resume file missing from storage')
    const resumeBytes = new Uint8Array(await obj.arrayBuffer())

    const { resumeData, parseError } = await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)

    // Parse fallback — badge cannot crash if Claude parse fails
    let finalData
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
