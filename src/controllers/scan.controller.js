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
const { revokeVerification, restoreVerification, recordTombstones, REVOKE_REASON } = require('../lib/verification')
const badgeService     = require('../services/badge.service')
const pdfService        = require('../services/pdf.service')
const docxService        = require('../services/docx.service')
const emailService        = require('../services/email.service')
const referralService      = require('../services/referral.service')
const rateLimiter          = require('../middleware/rateLimiter')
const { clientIp, rateKeyIp } = require('../lib/clientIp')
const { must, warnOnError, isRangeError } = require('../lib/db')
const { deriveJobTitle } = require('../lib/jobTitle')

// Maps the magic-byte-validated mimetype (middleware/upload.js only ever
// sets file.mimetype to one of these two, having already checked the bytes
// themselves) to a storage extension. Previously this took the extension
// straight from file.originalname — entirely client-supplied and never
// checked against anything, even though the validated type was already
// sitting right there on the same object. Not exploitable (R2 keys are
// flat strings, not filesystem paths, so no traversal risk), but it meant
// a file named "resume.docx" containing PDF bytes could get its PDF bytes
// stored under a `.docx` R2 key — cosmetic today since resume.parser.js
// correctly uses the validated mimetype (not this extension) to choose how
// to parse, but worth closing rather than leaving a trust gap on the table.
const EXT_BY_MIME = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
}
function extForMimeType(mimetype) {
  return EXT_BY_MIME[mimetype] || ''
}

// Shared by runAtsScan (new — see BUG FIX below) and generateFix/generateBadge
// (which already used this exact expression inline, twice). Factored out
// here rather than left duplicated four ways.
function candidateFirstNameFrom(resumeData) {
  return (resumeData?.name || '').split(' ')[0] || 'Candidate'
}

// Hoisted to module scope — was previously declared locally inside
// generateFix only; runAtsScan's WYSIWYG scoring fix below (see
// renderStructuredResumeText) needs the same constant.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// AUDIT FIX (bug — section audit "generate a resume from scratch"): brain-dump
// and saved-profile free scans previously scored resumeParser.serializeResumeData()'s
// synthetic plain-text rendering directly (see the two branches below in
// runAtsScan, before this fix). generateFix's own WYSIWYG-scoring comment
// further down this file already documents, from a real user report, that
// this exact synthetic text scores measurably differently than the real
// generated .docx — which is why the paid retry loop scores real docx bytes
// instead of trusting the synthetic serialization. That fix was never applied
// to the upstream FREE score for these two input modes, so a brain-dump/
// saved-profile user's very first score (and badgeEligible, which gates the
// cheaper BADGE tier before any purchase) was being computed off text the
// codebase's own audit history says is unreliable — while file-mode's free
// score already used real extracted text from the real uploaded file, making
// the two input-mode families' scores not apples-to-apples despite an
// identical UI treating them as directly comparable numbers.
//
// This renders the actual ATS docx (no verification URL — this runs pre-
// purchase, before any credential exists) and scores THAT, unifying every
// input mode's free score on the same real-file basis generateFix's retry
// loop already uses. Falls back to the synthetic text only if docx
// generation/extraction itself throws or comes back too short, so a
// rendering bug degrades scoring accuracy rather than failing the scan
// outright.
async function renderStructuredResumeText(resumeData) {
  try {
    const docxBytes = await docxService.generateAtsDocx(resumeData, null)
    const text = await resumeParser.extractText(docxBytes, DOCX_MIME)
    if (text && text.trim().length >= 100) return text
  } catch (err) {
    console.error('renderStructuredResumeText: docx render/extract failed, falling back to synthetic text:', err.message)
  }
  return resumeParser.serializeResumeData(resumeData)
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

  // A request that carried a session token but got no user because OUR lookup
  // failed (database hiccup) must not fall through as an anonymous submission.
  if (!user && ctx.get('authError') === 'unavailable')
    return ctx.json({ success: false, message: 'We could not verify your session just now. Please try again in a moment.' }, 503)

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
  const resumeKey = file ? storage.resumeKey(scanId, extForMimeType(file.mimetype)) : null

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
  const contactEmail = (fields.contactEmail || '').trim().toLowerCase()

  // The contact email is emailed a magic link when the scan completes — and
  // it is typed by an ANONYMOUS visitor — so it is validated like any other
  // address we will send to.
  if (!user && brainDumpText && contactEmail && !z.string().email().safeParse(contactEmail).success)
    return ctx.json({ success: false, message: 'Enter a valid email address.' }, 400)
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
      // What the dashboard tells scans apart by. A person who rescans one resume
      // against ten job descriptions used to see ten identical rows. Derived
      // from the JD text (best effort, may be null) plus the role category and
      // seniority the same text implies — both were previously only set once a
      // badge was generated, i.e. null for most scans.
      job_title:            deriveJobTitle(jdText),
      role_category:        atsService.detectRoleCategory(jdText),
      seniority_level:      atsService.detectSeniority(jdText),
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
      raw_brain_dump_text:  brainDumpWithContact.slice(0, c.MAX_RESUME_CHARS),
      // AUDIT FIX (feature gap): contactName/contactEmail were previously
      // ONLY folded into raw_brain_dump_text as a preamble for Claude to
      // read — never persisted as their own values. That meant the one
      // piece of infrastructure that could actually use a validated
      // anonymous email address (sending the person a link back to their
      // own scan once it's scored — see runAtsScan) had nothing durable to
      // read; the email existed for exactly one turn, inside a prompt.
      // Logged-in users don't need this (their account email is already the
      // right place to send to), which is why this is conditioned on !user.
      contact_name:   !user ? (contactName  || null) : null,
      contact_email:  !user ? (contactEmail || null) : null
    }
  }

  async function putFileIfNeeded() {
    if (!file) return
    await ctx.env.RESUMES_BUCKET.put(resumeKey, file.bytes, { httpMetadata: { contentType: file.mimetype } })
    uploaded = true
  }

  if (user) {
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0)

    // Atomic conditional increment (see 0008_atomic_scan_quota.sql) — avoids
    // a race between two concurrent createScan requests both seeing a
    // stale scans_today under the limit and both getting let through,
    // which the previous read-then-write here was exposed to (same class
    // of race redeem_free_fix_credit's RPC was already written to avoid,
    // just in this counter instead). Handles the daily reset inline too.
    const { data: allowed, error: quotaErr } = await supabase.rpc(
      'increment_scan_count_if_under_limit',
      { p_user_id: user.id, p_limit: c.FREE_SCANS_PER_DAY, p_today_midnight: todayMidnight.toISOString() }
    )
    if (quotaErr) throw quotaErr

    let bypassGranted = false
    if (!allowed) {
      const ip = clientIp(ctx)
      // Same RATE_LIMIT_BYPASS_IPS secret used by middleware/rateLimiter.js —
      // this is a separate DB-tracked limit (not KV-based), but reuses the
      // same testing toggle so there's one bypass to turn on/off, not two.
      if (!rateLimiter.isBypassed(ctx.env, ip)) {
        return ctx.json({ success: false, message: 'Daily scan limit reached. Upgrade for unlimited.' }, 429)
      }
      // Bypassed — the RPC already declined to increment, so grant the
      // slot manually for this request only (testing path, unmetered).
      warnOnError(await supabase.from('users').update({ scans_today: c.FREE_SCANS_PER_DAY }).eq('id', user.id), 'quota bypass grant')
      bypassGranted = true
    }

    // FEATURE GAP CLOSED (Auth/Scan round): the free quota is per ACCOUNT, and
    // an account needs nothing but an email address — no verification is
    // required to scan — so N throwaway accounts were N x 3 free scans, each
    // one a paid Claude call. A per-IP ceiling across all accounts closes the
    // farm without touching normal use (default 15 scans/day/IP, i.e. five
    // accounts' worth; SCAN_IP_DAILY_CAP overrides it, 0 disables it; the
    // testing-bypass IPs are exempt). The slot is only spent AFTER the account
    // quota said yes, and the account slot is handed back if this refuses.
    {
      const ip = clientIp(ctx)
      const envCap = parseInt(ctx.env.SCAN_IP_DAILY_CAP, 10)
      const ipCap = Number.isFinite(envCap) ? envCap : c.FREE_SCANS_PER_IP_PER_DAY
      if (ipCap > 0 && !rateLimiter.isBypassed(ctx.env, ip)) {
        const ipOk = await rateLimiter.hitQuota(ctx.env, `rl:scanip:${rateKeyIp(ip)}`, ipCap, 24 * 3600)
        if (!ipOk) {
          warnOnError(await supabase.rpc('decrement_scan_count', { p_user_id: user.id }), 'scan quota rollback (ip cap)')
          await cleanupFile()
          return ctx.json({ success: false, message: 'Too many scans from this network today. Please try again tomorrow.' }, 429)
        }
      }
    }

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
      // Return the slot — scan was not created.
      // AUDIT FIX (bug — Scan/ATS section audit): this used to only roll
      // back `if (allowed)` — the manual bypass grant above (testing IPs
      // only) was never reverted on a failed insert, so a bypass IP that
      // hit this failure path kept its manually-granted slot regardless.
      // Low-stakes (testing-only surface), but decrement_scan_count is the
      // exact same RPC that already exists to undo one granted slot either
      // way, so there's no reason for the two paths to behave differently.
      // NOTE: supabase-js query builders are thenable (have .then) but are not
      // real Promise instances, so .catch() doesn't exist on them directly —
      // must go through a real try/catch (or await) instead.
      if (allowed || bypassGranted) {
        // supabase-js reports a failed RPC as `{ error }` and never throws, so
        // the result must be inspected — a bare try/catch around it can't fire.
        warnOnError(await supabase.rpc('decrement_scan_count', { p_user_id: user.id }), 'scan quota rollback')
      }
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
  // Timing-safe comparison — matches the convention already used for the
  // Paystack webhook signature (cryptoLib.timingSafeEqual). The plain ===
  // this replaces wasn't a realistic exploit path (a random UUID over the
  // network), but it was an inconsistency against a gap this codebase
  // otherwise closes deliberately everywhere else a secret token is checked.
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && cryptoLib.timingSafeEqual(scan.anonToken, ctx.req.query('token') || ''))
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
// FEATURE (feature gap): ats.service.js's scoreResume() has always computed
// real, actionable detail for every scan — which JD keywords are missing,
// which sections are absent, which format issues fired — and runAtsScan
// persists all of it to full_ats_report. Until now getScan() unconditionally
// stripped that field before it ever reached the frontend, and the frontend
// had no UI for it even if it hadn't: CategoryScores.jsx renders four bare
// numbers with no explanation of WHY. This is the exact detail
// describeWeakAreas() already feeds Claude to drive the paid rewrite retry
// loop — the app has always "known" what's wrong with a scan, it just never
// told the person who scanned it.
//
// Reshaped into a small, stable, presentational subset rather than passing
// the raw internal report straight through — full_ats_report is an
// implementation detail (its exact shape is free to change inside
// ats.service.js) and this is the public contract built on top of it.
// aiMissingKeywords is the other half of this same gap — see blendAiScore
// below.
function buildAtsDetail(fullAtsReport) {
  if (!fullAtsReport || fullAtsReport.error) return null
  return {
    keywords: {
      matched: fullAtsReport.keywords?.matched || [],
      missing: fullAtsReport.keywords?.missing || []
    },
    sections: {
      found:   fullAtsReport.sections?.found   || [],
      missing: fullAtsReport.sections?.missing || [],
      // Informational-only flags from ats.service.js (don't affect score) —
      // surfaced so the UI can suggest them as optional improvements rather
      // than silently computing and discarding them like the rest of this
      // report used to be.
      hasCertifications: fullAtsReport.sections?.hasCertifications ?? null,
      hasProjects:       fullAtsReport.sections?.hasProjects ?? null
    },
    format: {
      issues: fullAtsReport.format?.issues || []
    },
    content: {
      actionVerbRate:  fullAtsReport.content?.actionVerbRate ?? null,
      quantifiedCount: fullAtsReport.content?.quantifiedCount ?? null
    },
    aiMissingKeywords: fullAtsReport.aiMissingKeywords || []
  }
}

// Shared by runAtsScan and updateResumeData: both call scoreResumeWithAI and
// blend its aiScore into the rule-based score. FEATURE: scoreResumeWithAI's
// prompt has always asked Claude for missingKeywords alongside aiScore, but
// both call sites only ever read aiScore back out — the AI's own view of
// what's missing (semantically aware, catches synonyms/related terms the
// rule-based stemmer can't) was computed and paid for, then silently
// discarded, at both call sites. Blends the score exactly as before and
// also returns whatever missing-keyword list Claude provided, for the
// caller to persist onto full_ats_report.aiMissingKeywords.
// Removes empty strings the editor sends for untouched lines: blank bullets,
// blank skills / certifications / technologies.
function dropBlankEntries(rd) {
  const keep = arr => (Array.isArray(arr) ? arr.filter(x => typeof x !== 'string' || x.trim()) : arr)
  return {
    ...rd,
    skills: keep(rd.skills),
    certifications: keep(rd.certifications),
    experience: Array.isArray(rd.experience) ? rd.experience.map(e => ({ ...e, bullets: keep(e.bullets) })) : rd.experience,
    projects: Array.isArray(rd.projects) ? rd.projects.map(p => ({ ...p, technologies: keep(p.technologies) })) : rd.projects,
  }
}

// AUDIT FIX (Auth/Scan round): a scan that ends in ERROR because of a fault on
// OUR side (or one that produced nothing at all) used to keep the free-scan
// slot it consumed — the person lost one of their 3 daily scans and got no
// result for it. Handed back here, but only when the scan was created today
// (after the daily reset the counter already belongs to a different day) and
// never for a failure that is the person's own doing while still costing us
// money (see the call sites).
async function refundScanQuota(supabase, scan, label) {
  if (!scan || !scan.userId || !scan.createdAt) return
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  if (new Date(scan.createdAt) < startOfToday) return
  warnOnError(await supabase.rpc('decrement_scan_count', { p_user_id: scan.userId }), label)
}

// AUDIT FIX (Auth/Scan round): the AI's number went into the blend unchecked.
// An aiScore of 1000 — from a hallucination, or from text hidden in the resume
// or JD telling the model what to answer — produced a flat 100 and unlocked
// the "Verified" credential. The AI opinion is now (1) required to be a finite
// number, (2) clamped to 0-100, and (3) allowed to sit at most
// AI_MAX_ABOVE_RULE points above the deterministic score: an AI verdict far
// ABOVE what the rules measure is exactly what injection looks like, while
// honest disagreement stays within a normal range.
const AI_MAX_ABOVE_RULE = 25
function blendAiScore(ruleScore, aiResult, logLabel) {
  let finalScore = ruleScore
  let aiMissingKeywords = []
  if (aiResult.success) {
    try {
      const parsed = claudeService.extractJson(aiResult.data)
      if (typeof parsed.aiScore === 'number' && Number.isFinite(parsed.aiScore)) {
        const ai = Math.min(Math.max(parsed.aiScore, 0), 100, ruleScore + AI_MAX_ABOVE_RULE)
        finalScore = Math.round((ruleScore * c.ATS_RULE_WEIGHT) + (ai * c.ATS_AI_WEIGHT))
      }
      if (Array.isArray(parsed.missingKeywords))
        aiMissingKeywords = parsed.missingKeywords
          .filter(k => typeof k === 'string' && k.trim() && k.length <= 60).map(k => k.trim()).slice(0, 15)
    } catch (parseErr) {
      // Non-fatal by design — falls back to rule-only score — but log it
      // so a silent AI-scoring degradation is at least visible in tail.
      console.error(`${logLabel} AI score parse failed, using rule-only score:`, parseErr.message)
    }
  }
  return { finalScore: Math.max(0, Math.min(100, finalScore)), aiMissingKeywords }
}

async function getScan(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return ctx.json({ success: false, message: 'Not found.' }, 404)

  const user = ctx.get('user')
  // Timing-safe comparison — see matching note in getScanStatus above.
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && cryptoLib.timingSafeEqual(scan.anonToken, ctx.req.query('token') || ''))
  if (!isOwner) return ctx.json({ success: false, message: 'Access denied.' }, 403)

  const { fullAtsReport, resumePath, resumeAtsPath, resumePdfPath, resumeHashHistory, fixPaymentId, ...safe } = scan
  const badgeEligible = scan.atsScore != null ? scan.atsScore >= c.ATS_BADGE_THRESHOLD : null
  const atsDetail = buildAtsDetail(fullAtsReport)
  // AUDIT FIX (Auth/Scan round): the storage keys are (rightly) not exposed —
  // but that also hid whether a PDF EXISTS. A failed PDF render is silent by
  // design (the DOCX still delivers), so the page kept offering "Download PDF"
  // forever, answering "File not ready yet." to every click. These two flags
  // let the UI show what is really there and offer a regeneration.
  return ctx.json({ success: true, data: { ...safe, badgeEligible, atsDetail, hasDocx: !!resumeAtsPath, hasPdf: !!resumePdfPath } })
}

// Loosely mirrors the shape claude.service.js's parseResumeStructure /
// structureFreeformText produce — permissive (`.passthrough()`) rather than
// strict, since this only needs to catch a genuinely malformed body, not
// police every field. Shared between updateResumeData below and nowhere
// else (the AI-generation call sites intentionally do NOT run their output
// through this — that would just be a second, redundant thing to keep in
// sync with the prompt's own schema).
const MAX_RESUME_DATA_JSON_CHARS = 100_000
const resumeDataSchema = z.object({
  name:      z.string().nullable().optional(),
  email:     z.string().nullable().optional(),
  phone:     z.string().nullable().optional(),
  location:  z.string().nullable().optional(),
  linkedin:  z.string().nullable().optional(),
  portfolio: z.string().nullable().optional(),
  summary:   z.string().nullable().optional(),
  experience: z.array(z.object({
    company: z.string().nullable().optional(),
    title:   z.string().nullable().optional(),
    dates:   z.string().nullable().optional(),
    bullets: z.array(z.string()).optional()
  })).optional(),
  education: z.array(z.object({
    institution: z.string().nullable().optional(),
    degree:      z.string().nullable().optional(),
    dates:       z.string().nullable().optional()
  })).optional(),
  skills:         z.array(z.string()).optional(),
  certifications: z.array(z.string()).optional(),
  projects: z.array(z.object({
    name:         z.string().nullable().optional(),
    description:  z.string().nullable().optional(),
    technologies: z.array(z.string()).optional(),
    link:         z.string().nullable().optional()
  })).optional()
}).passthrough()

// PATCH /api/scan/:id/resume-data
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// previously there was no way for a brain-dump (or saved-profile) user to
// see, let alone correct, what Claude actually extracted from their text
// before it became the basis for their score and — if they went on to pay —
// their delivered resume. getScan above already returned
// originalResumeData to the owner from COMPLETE_PASS/COMPLETE_FAIL onward;
// nothing in the frontend ever rendered it, and there was no endpoint to
// write a correction back even if it had. This closes both halves: the
// frontend can now show the extracted data (see ResumeDataEditor.jsx) and —
// via this endpoint — save a correction and get an accurate rescore, all
// before any money changes hands.
//
// Deliberately NOT gated behind the `auth` middleware (see scan.routes.js)
// — an anonymous brain-dump submitter should be able to fix an extraction
// error before they've even decided whether to register, same ownership
// model as getScan/getScanStatus above (anon_token via query param).
//
// Scoped to brain_dump/saved_profile only: file-mode's structured data
// doesn't exist yet at this stage (see generateFix, which is the first
// place a file-mode resumeData object is ever produced) and correcting a
// genuine uploaded file's content isn't this feature's job. Also scoped to
// pre-purchase only — once a fix exists, retryFix's feedback loop is the
// intended way to iterate on it, not silently rewriting the source data
// underneath an in-flight or already-delivered fix.
async function updateResumeData(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return ctx.json({ success: false, message: 'Not found.' }, 404)

  const user = ctx.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && cryptoLib.timingSafeEqual(scan.anonToken, ctx.req.query('token') || ''))
  if (!isOwner) return ctx.json({ success: false, message: 'Access denied.' }, 403)

  if (!['brain_dump', 'saved_profile'].includes(scan.inputMode))
    return ctx.json({ success: false, message: 'Only available for brain-dump or saved-profile scans.' }, 400)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return ctx.json({ success: false, message: 'Scan must be complete to edit.' }, 400)
  if (scan.fixPurchased)
    return ctx.json({ success: false, message: 'Already purchased — use "Try Again" on the delivered fix instead.' }, 400)

  let body
  try {
    body = await ctx.req.json()
  } catch (_) {
    return ctx.json({ success: false, message: 'Invalid request body.' }, 400)
  }
  // Bounded BEFORE it is validated, rendered to a docx and stored as JSONB:
  // the schema is deliberately permissive (`.passthrough()`), so it can't be
  // relied on to cap size. A real structured resume is a few KB.
  if (JSON.stringify(body?.resumeData ?? null).length > MAX_RESUME_DATA_JSON_CHARS)
    return ctx.json({ success: false, message: 'Resume data is too large.' }, 400)
  const parsedBody = resumeDataSchema.safeParse(body?.resumeData)
  if (!parsedBody.success)
    return ctx.json({ success: false, message: 'Resume data is not in the expected shape.' }, 400)
  // AUDIT FIX (Auth/Scan round): the editor sends a bullet/skill for every
  // line the person typed, including blank ones; blanks were saved and became
  // empty "•" lines in the delivered documents.
  const resumeData = dropBlankEntries(parsedBody.data)

  // Same WYSIWYG scoring basis as runAtsScan's own brain_dump/saved_profile
  // branches (see renderStructuredResumeText above) and the same AI/rule
  // blend the original free scan used — an edit-triggered rescore should
  // land on a number computed the exact same way the first one was, not a
  // cheaper approximation that could disagree with it for reasons that have
  // nothing to do with the actual edit.
  const jdText = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
  const rawResumeText = (await renderStructuredResumeText(resumeData)).slice(0, c.MAX_RESUME_TEXT_CHARS)
  const ruleResult = atsService.scoreResume(rawResumeText, jdText)

  const aiResult = await claudeService.scoreResumeWithAI(ctx.env, rawResumeText, jdText)
  const { finalScore, aiMissingKeywords } = blendAiScore(ruleResult.score, aiResult, 'updateResumeData')
  const status = finalScore >= c.ATS_PASS_THRESHOLD ? 'COMPLETE_PASS' : 'COMPLETE_FAIL'

  // AUDIT FIX (Auth/Scan round): the write was keyed on id alone, but the
  // checks above were made BEFORE a multi-second Claude call. A payment that
  // landed in that window (status -> FIX_PURCHASED, fix_purchased -> true) was
  // then overwritten: status silently reverted to COMPLETE_*, and the paid
  // fix could be generated from data edited after the purchase. The write now
  // only applies while the scan is still exactly what was checked.
  const { data: updated, error: updErr } = await supabase.from('scans').update({
    original_resume_data: resumeData,
    ats_score:       finalScore,
    passed:          finalScore >= c.ATS_PASS_THRESHOLD,
    keyword_score:   ruleResult.keywordScore,
    format_score:    ruleResult.formatScore,
    sections_score:  ruleResult.sectionsScore,
    content_score:   ruleResult.contentScore,
    full_ats_report: { ...ruleResult.detail, aiMissingKeywords },
    status
  }).eq('id', scan.id).eq('fix_purchased', false).in('status', ['COMPLETE_PASS', 'COMPLETE_FAIL']).select('id')
  if (updErr) throw updErr
  if (Array.isArray(updated) && updated.length === 0)
    return ctx.json({ success: false, message: 'This scan changed while you were editing (a purchase may be in progress). Refresh the page and try again.' }, 409)

  return ctx.json({ success: true, data: {
    originalResumeData: resumeData,
    atsScore:      finalScore,
    passed:        finalScore >= c.ATS_PASS_THRESHOLD,
    badgeEligible: finalScore >= c.ATS_BADGE_THRESHOLD,
    keywordScore:  ruleResult.keywordScore,
    formatScore:   ruleResult.formatScore,
    sectionsScore: ruleResult.sectionsScore,
    contentScore:  ruleResult.contentScore,
    status
  }})
}

// GET /api/scan/:id/download-draft
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// previously a brain-dump/saved-profile user who chose not to purchase a
// fix got NOTHING tangible back — not even the plain resume built from
// their own text — despite ScanForm.jsx's CTA literally promising "Build &
// Score My Resume — Free". Unlike a file-upload user (who always still has
// their own original file regardless of what Passthrough does with it), a
// brain-dump user's only representation of their work history lived
// entirely inside this app, behind a paywall. This generates the same ATS-
// formatted .docx docxService already produces for a paid fix — WITHOUT any
// AI rewrite, credential, or verification link — on demand and free, from
// whatever original_resume_data currently exists (including any correction
// made via updateResumeData above). Deliberately NOT persisted to R2:
// generation is cheap and deterministic (no Claude call), so there's no
// reason to pay storage cost for a file that regenerates identically from
// data already on the row. Same ownership model as getScan (anon_token via
// query param) — an anonymous user shouldn't have to register just to get
// back the resume they already built for free.
async function downloadDraft(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan) return ctx.json({ success: false, message: 'Not found.' }, 404)

  const user = ctx.get('user')
  const isOwner = (scan.userId && scan.userId === user?.id) ||
                  (scan.anonToken && cryptoLib.timingSafeEqual(scan.anonToken, ctx.req.query('token') || ''))
  if (!isOwner) return ctx.json({ success: false, message: 'Access denied.' }, 403)

  if (!['brain_dump', 'saved_profile'].includes(scan.inputMode))
    return ctx.json({ success: false,
      message: 'A draft download is only available for brain-dump or saved-profile scans — file uploads already have your original file.' }, 400)
  if (!scan.originalResumeData)
    return ctx.json({ success: false, message: 'Not ready yet — the scan needs to finish first.' }, 404)

  const docxBytes = await docxService.generateAtsDocx(scan.originalResumeData, null)
  ctx.header('Content-Disposition', 'attachment; filename="resume-draft.docx"')
  ctx.header('Content-Type', DOCX_MIME)
  return ctx.body(docxBytes)
}

// POST /api/scan/:id/initiate-fix
async function initiateFix(ctx) {
  const user = ctx.get('user')
  const body = await ctx.req.json()
  const { fixTier, referralCode } = z.object({
    fixTier:      z.enum(['FIX', 'BADGE', 'FIX_PLAIN']),
    referralCode: z.string().max(50).optional()
  }).parse(body)

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

  // Same resolver /api/pricing and /api/payments/initialize use — see
  // services/referral.service.js. Kept in sync here even though the current
  // frontend checkout calls /api/payments/initialize directly rather than
  // this endpoint, so this quote can never show a different number than
  // what a payment would actually charge.
  const priced = await referralService.resolvePrice(supabase, fixTier, ctx.env, referralCode)
  const promoActive = c.isPromoActive(ctx.env)
  // AUDIT FIX (bug): originalAmount used to branch on referralApplied and,
  // in that branch, anchor on c.priceForTier(fixTier, ctx.env) — the
  // current promo/standard price — rather than the true pre-promo standard
  // price. pricing.controller.js's getPricing (the public quote this
  // endpoint's own comment above says it's "kept in sync" with) anchors
  // originalAmount on c.standardPriceForTier(tier) UNCONDITIONALLY,
  // referral code or not, specifically so the strikethrough "was $X" never
  // depends on which discount layer is active. This endpoint disagreed with
  // that in exactly the referral+promo-both-active case, which would have
  // shown two different "was" prices for the same scan+tier+code depending
  // which endpoint served the quote. No live impact today — the frontend
  // checkout calls /api/payments/initialize directly, never this endpoint
  // (see the comment above) — but fixed here so a future caller of this
  // route can't silently disagree with the public price quote.
  return ctx.json({ success: true, data: {
    amount: priced.amount, currency: priced.currency, scanId: scan.id, fixTier,
    // originalAmount/promoActive let the checkout UI show the same
    // anchor+slash treatment as the public pricing page, without a second,
    // independently-maintained price table on the frontend.
    originalAmount: c.standardPriceForTier(fixTier),
    promoActive,
    referralApplied: priced.referralApplied
  } })
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

  // BUG FIX: everything from here on used to be unprotected — if the
  // payment insert, the scan update, or the queue send threw, the credit
  // was already gone (decremented above) but nothing was ever delivered.
  // Wrap the rest in try/catch and refund the credit via
  // increment_free_fix_credits (the same RPC retryFix's exhausted-retries
  // path already uses to grant a credit) on any failure, so a transient
  // DB/queue error costs the user nothing. Re-throw afterward so the
  // request still surfaces as an error to the caller/errorHandler.
  let creditPaymentId = null
  let claimObtained = false
  try {
    // Recorded as a $0 payment so payment history stays complete and
    // consistent — same shape as a real transaction, just free.
    // AUDIT FIX (Section 3/4 pass, bug): fix_tier was never set here, unlike
    // every real (paid) payment row — payments.controller.js's initializePayment
    // stores fix_tier on the payment row itself as the documented single
    // source of truth for exactly this reason (see its top-of-file comment).
    // A free-credit redemption always grants the 'FIX' tier (see the scans
    // update right below, which DOES set it), so leaving it off here was
    // pure oversight, not a different tier semantics. Consumed today by
    // getPaymentHistory (payments.controller.js) → PaymentHistory.jsx, whose
    // Item column showed a bare "—" instead of "Fix + Credential" for every
    // free-credit purchase, since TIER_LABEL[null] and p.fixTier are both
    // falsy.
    const { data: creditPayment, error: paymentErr } = await supabase.from('payments').insert({
      amount_cents: 0,
      currency:     ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
      status:       'SUCCESS',
      fix_tier:     'FIX',
      paystack_ref: `credit:${scan.id}:${Date.now()}`,
      user_id:      user.id,
      scan_id:      scan.id
    }).select('id').single()
    if (paymentErr) throw paymentErr
    creditPaymentId = creditPayment.id

    // SECTION 8 AUDIT: this is a CLAIM, same as fulfillment.service — it used
    // to be an unconditional update, so a credit redeemed while a paid checkout
    // for the same scan was still open (or vice versa) fulfilled the scan twice.
    // Losing the claim throws into the catch below, which refunds the credit.
    const { data: claimed, error: scanUpdateErr } = await supabase.from('scans').update({
      fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: 'FIX', fix_payment_id: creditPaymentId
    }).eq('id', scan.id).eq('fix_purchased', false).select('id')
    if (scanUpdateErr) throw scanUpdateErr
    if (!claimed || claimed.length === 0) throw new Error('Scan was purchased concurrently')
    claimObtained = true

    await ctx.env.FIX_QUEUE.send({ type: 'generateFix', scanId: scan.id })
  } catch (err) {
    // If the claim was LOST, the $0 row must not linger as a SUCCESS payment for
    // this scan — it would make fulfilment think the scan has a second purchase.
    // (If the claim was WON and only the queue send failed, the row is the
    // scan's legitimate owning payment and the sweeps will finish delivery.)
    if (creditPaymentId && !claimObtained) {
      try { await supabase.from('payments').update({ status: 'FAILED' }).eq('id', creditPaymentId) } catch (_) {}
    }
    console.error(`[CRITICAL] redeemCredit fulfillment failed after credit consumed (user ${user.id}, scan ${scan.id}):`, err.message)
    try {
      // must(): supabase-js reports a failed RPC as `{ error }` and never
      // throws — without this the catch below (and its owner alert, which
      // already existed but could never fire) silently never ran.
      must(await supabase.rpc('increment_free_fix_credits', { p_user_id: user.id }), 'refund free fix credit')
    } catch (refundErr) {
      // Refund itself failed — this is the one case that genuinely needs a
      // human, since the credit is stuck consumed with no automatic path
      // back. Alert rather than silently swallow.
      console.error(`[CRITICAL] redeemCredit credit refund ALSO failed (user ${user.id}, scan ${scan.id}):`, refundErr.message)
      try {
        await emailService.sendOwnerAlert(ctx.env,
          'redeemCredit refund failed — credit stuck consumed',
          `userId: ${user.id}\nscanId: ${scan.id}\noriginal error: ${err.message}\nrefund error: ${refundErr.message}\n\nManually restore this user's free_fix_credits by 1.`
        )
      } catch (_) {}
    }
    throw err
  }

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
  if (!['FIX', 'FIX_PLAIN'].includes(scan.fixTier))
    return ctx.json({ success: false, message: 'Retries are only available for Fix tiers — Badge issues no rewrite, so there is nothing a retry would change.' }, 400)
  if (scan.status !== 'FIX_DELIVERED')
    return ctx.json({ success: false, message: 'This fix must finish generating before it can be retried.' }, 400)
  if (typeof scan.fixAtsScore === 'number' && scan.fixAtsScore >= c.ATS_BADGE_THRESHOLD)
    return ctx.json({ success: false, message: 'This fix already reached the target score — nothing to retry.' }, 400)
  if (scan.fixRetryCount >= c.MAX_FIX_RETRIES)
    return ctx.json({ success: false, message: 'No retries remaining for this fix.' }, 400)

  // Atomic gate (see 0009_atomic_fix_retry.sql) — the checks above give a
  // fast, specific error for the common case, but a plain read-then-write
  // here would let two concurrent retry requests (double-click, two tabs)
  // both read the same stale fix_retry_count, both pass those checks, and
  // both enqueue a generateFix job against the same scan. This RPC folds
  // every gating condition into one UPDATE...WHERE, so only one concurrent
  // request can ever win. Returns the new retry count, or -1 if nothing
  // matched (lost the race, or state changed since the reads above).
  const { data: newRetryCount, error: rpcErr } = await supabase.rpc('increment_fix_retry_if_available', {
    p_scan_id: scan.id, p_max_retries: c.MAX_FIX_RETRIES, p_badge_threshold: c.ATS_BADGE_THRESHOLD
  })
  if (rpcErr) throw rpcErr
  if (newRetryCount < 0)
    return ctx.json({ success: false, message: 'Could not start a retry — it may already be in progress. Refresh and try again.' }, 400)

  // The RPC above has ALREADY spent one retry and flipped the scan to
  // FIX_GENERATING. If the job then can't be enqueued, nothing will ever
  // generate it. Undo both changes atomically so the user can simply press
  // "Try Again" once more.
  try {
    await ctx.env.FIX_QUEUE.send({ type: 'generateFix', scanId: scan.id })
  } catch (queueErr) {
    console.error(`[CRITICAL] retryFix could not enqueue (scan ${scan.id}):`, queueErr.message)
    try {
      must(await supabase.rpc('revert_fix_retry', { p_scan_id: scan.id }), 'revert fix retry')
    } catch (revertErr) {
      console.error(`[CRITICAL] retryFix revert ALSO failed (scan ${scan.id}):`, revertErr.message)
      try {
        await emailService.sendOwnerAlert(ctx.env, 'retryFix: enqueue and revert both failed',
          `scanId: ${scan.id}\nenqueue error: ${queueErr.message}\nrevert error: ${revertErr.message}\n\nThe scan is stuck in FIX_GENERATING with a retry consumed.`)
      } catch (_) {}
    }
    throw queueErr
  }

  return ctx.json({ success: true, data: { retriesRemaining: c.MAX_FIX_RETRIES - newRetryCount } })
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
  // SECTION 7 AUDIT (feature gap): the owner had no way to hide their first
  // name from the public page, nor to switch the page off at all.
  if (typeof body.hideName   === 'boolean') update.verify_hide_name   = body.hideName
  const wantsPublish = typeof body.published === 'boolean'
  if (Object.keys(update).length === 0 && !wantsPublish)
    return ctx.json({ success: false, message: 'Nothing to update — expected exposeDocx, exposePdf, hideName and/or published as booleans.' }, 400)

  // ROUND-2 AUDIT FIX (bug, Section 7): the visibility flags used to be written
  // BEFORE the republish was decided, so a refused republish (403 — the page was
  // taken down by Passthrough, not the owner) still saved exposeDocx/exposePdf as
  // a side effect of an error response, and they would silently go live if an
  // admin later restored the page. The republish is now decided first; a refusal
  // changes nothing.
  let status = scan.verificationStatus || 'ACTIVE'
  if (wantsPublish && body.published === true && status === 'REVOKED') {
    // The owner may only undo THEIR OWN unpublish — never a refund/dispute/admin/ban takedown.
    const restored = await restoreVerification(supabase, scan.id)
    if (!restored)
      return ctx.json({ success: false, message: 'This verification page was revoked by Passthrough and cannot be republished. Contact support if you think this is a mistake.' }, 403)
    status = 'ACTIVE'
  }

  if (Object.keys(update).length > 0) {
    const { error: updateErr } = await supabase.from('scans').update(update).eq('id', scan.id)
    if (updateErr) throw updateErr
  }

  if (wantsPublish && body.published === false) {
    await revokeVerification(supabase, scan.id, REVOKE_REASON.OWNER)
    status = 'REVOKED'
  }

  return ctx.json({ success: true, data: {
    exposeDocx: update.verify_expose_docx ?? scan.verifyExposeDocx,
    exposePdf:  update.verify_expose_pdf  ?? scan.verifyExposePdf,
    hideName:   update.verify_hide_name   ?? scan.verifyHideName ?? false,
    published:  status !== 'REVOKED',
    verificationStatus: status,
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
  // ROUND-2 AUDIT: any other value used to fall through to the PDF branch.
  if (type !== 'ats' && type !== 'pdf')
    return ctx.json({ success: false, message: 'type must be "ats" or "pdf".' }, 400)
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
// Allowlist for the ?status= filter below — mirrors the same
// allowlist-rather-than-validate-and-error pattern used by
// employer-leads.controller.js's LEAD_STATUSES (an unrecognized value is
// silently ignored rather than filtered on, since this is a narrowing
// convenience, not a security boundary).
const SCAN_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']

// Same reasoning as admin.controller.js's pageParams() (see its comment): a
// client-controlled limit with no ceiling lets a stray/malicious
// ?limit=1000000 turn a paginated endpoint into a full-table dump in one
// request. That was already fixed there; it wasn't fixed here.
const MAX_SCAN_HISTORY_LIMIT = 100

// What the dashboard search box matches: the uploaded file's name, the
// candidate's first name (brain-dump / saved-profile scans have no file), and
// the job title taken from the JD — so "Google" or "analyst" finds the scan.
const HISTORY_SEARCH = (term) =>
  `resume_original_name.ilike.%${term}%,candidate_first_name.ilike.%${term}%,job_title.ilike.%${term}%`

async function getScanHistory(ctx) {
  const user = ctx.get('user')
  // Clamped to at least 1 — a page of 0 or negative previously reached
  // Supabase's `.range()` with a negative offset untouched.
  const page  = Math.max(parseInt(ctx.req.query('page')) || 1, 1)
  // BUG FIX (audit): this used to be `parseInt(ctx.req.query('limit')) || 10`
  // with no upper bound at all — unlike every admin list endpoint, which
  // goes through pageParams()'s explicit 100-row cap for exactly this
  // reason. Any authenticated user could request their own history with
  // ?limit=1000000 and force one unbounded read. Clamped the same way here:
  // at least 1, at most MAX_SCAN_HISTORY_LIMIT.
  const limit = Math.min(MAX_SCAN_HISTORY_LIMIT, Math.max(1, parseInt(ctx.req.query('limit')) || 10))
  const from = (page - 1) * limit
  const to   = from + limit - 1

  // FEATURE GAP CLOSED (Section 6, fixing-time pass): dashboard/Index.jsx
  // got real pagination in the previous pass, but nothing to actually FIND
  // an older scan once there's more than a page of them — no search, no
  // status filter, even though every comparable admin list (AdminUsers,
  // AdminLeads) already has both. Same sanitize-then-ilike / allowlisted-
  // status pattern as those.
  // Same stripping as the employer-leads search: everything with meaning inside
  // a PostgREST .or() string or an ilike pattern (`_` stays — it only widens a match).
  const search = String(ctx.req.query('search') || '').replace(/[,()"%\\*]/g, '').trim()
  const status = ctx.req.query('status')

  const supabase = getSupabase(ctx.env)
  // AUDIT FIX (Section 6): this endpoint always accepted page/limit, but
  // never returned a total — the dashboard had no way to know whether more
  // scans existed beyond whatever page it happened to ask for, and (see
  // Index.jsx) it never asked for more than page 1 anyway. `count: 'exact'`
  // adds one extra index-only count against the same filtered query, not a
  // second round trip.
  let query = supabase
    .from('scans')
    .select('id, status, ats_score, passed, resume_original_name, input_mode, created_at, fix_purchased, fix_tier, verification_code, verification_status, fix_ats_score, keyword_score, format_score, sections_score, content_score, job_title, role_category, seniority_level, updated_at', { count: 'exact' })
    .eq('user_id', user.id)
  // BUG FIX (audit): this comment previously claimed candidate_first_name
  // was "populated at scoring time for every scan (see runAtsScan)" — it
  // wasn't. Until now it was only ever set inside generateFix/generateBadge,
  // i.e. only after a Fix/Badge was purchased, which meant this search
  // silently did nothing for the free/unpurchased brain-dump and
  // saved-profile scans it was written to help (the vast majority of them).
  // runAtsScan now sets it at scoring time for those two modes (see above) —
  // file-mode doesn't need it here since it already has resume_original_name
  // to search on instead.
  if (search) query = query.or(HISTORY_SEARCH(search))
  if (status && SCAN_STATUSES.includes(status)) query = query.eq('status', status)

  let { data: rows, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })   // total order: created_at ties must not shuffle rows between pages
    .range(from, to)
  if (isRangeError(error)) {
    // A page past the end (scans since removed, a stale bookmark, a hand-edited
    // ?page=): an empty page with the real total, so the dashboard can step
    // back to the last real page instead of dead-ending on an error.
    let head = supabase.from('scans').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
    if (search) head = head.or(HISTORY_SEARCH(search))
    if (status && SCAN_STATUSES.includes(status)) head = head.eq('status', status)
    const totals = await head
    if (totals.error) throw totals.error
    rows = []; count = totals.count; error = null
  }
  if (error) throw error

  const scans = rows.map(r => ({
    id: r.id, status: r.status, atsScore: r.ats_score, passed: r.passed,
    resumeOriginalName: r.resume_original_name, inputMode: r.input_mode, createdAt: r.created_at,
    fixPurchased: r.fix_purchased, fixTier: r.fix_tier, verificationCode: r.verification_code,
    verificationStatus: r.verification_status, fixAtsScore: r.fix_ats_score,
    keywordScore: r.keyword_score, formatScore: r.format_score,
    sectionsScore: r.sections_score, contentScore: r.content_score,
    // Label + the deletion rule's clock (see deleteScan's in-flight window).
    jobTitle: r.job_title ?? null, roleCategory: r.role_category ?? null,
    seniorityLevel: r.seniority_level ?? null, updatedAt: r.updated_at
  }))

  return ctx.json({ success: true, data: { scans, page, limit, total: count } })
}

// DELETE /api/scan/:id
// A user could only ever remove their scans by deleting the whole account: the
// resume file, job description, structured data and rewritten documents of
// every scan stayed until then. This removes ONE scan and everything stored
// for it.
//
//  * Owner only — and a scan that isn't yours is a 404, same as one that
//    doesn't exist, so the endpoint can't be used to probe scan ids.
//  * Not while the scan is being worked on: the background job writes its
//    results when it finishes, which would recreate data (and re-upload files)
//    for a scan the user just deleted. Untouched for an hour = the job died
//    (the hourly cron flips those to ERROR), so it never blocks deletion for
//    good. The same goes for a payment still in flight on the scan.
//  * A paid scan CAN be deleted — its verification page stops existing with
//    it, which the UI says before confirming. payments.scan_id is
//    `on delete set null`, so the receipt and its history survive.
//  * The saved profile is a separate copy the user chose to keep; only its
//    "view source scan" pointer is cleared.
//  * R2 objects go after the row, best-effort and logged: object storage is
//    not part of the DB transaction, and a leaked object is visible in logs
//    (the row is gone, so nothing else can ever refer to it).
const SCAN_IN_FLIGHT_STATUSES = ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']
const SCAN_IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000

async function deleteScan(ctx) {
  const user = ctx.get('user')
  const id = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)

  const { data: row, error } = await supabase.from('scans')
    .select('id, user_id, status, updated_at, resume_path, resume_ats_path, resume_pdf_path, verification_code')
    .eq('id', id).maybeSingle()
  if (error) throw error
  if (!row || row.user_id !== user.id) return ctx.json({ success: false, message: 'Scan not found.' }, 404)

  const since = new Date(Date.now() - SCAN_IN_FLIGHT_WINDOW_MS).toISOString()
  if (SCAN_IN_FLIGHT_STATUSES.includes(row.status) && row.updated_at > since)
    return ctx.json({ success: false, message: 'This scan is still being processed. Try again in a few minutes.' }, 409)

  const { count: pendingPayments, error: payErr } = await supabase.from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('scan_id', id).eq('status', 'PENDING').gt('created_at', since)
  if (payErr) throw payErr
  if (pendingPayments > 0)
    return ctx.json({ success: false, message: 'A payment for this scan is still in progress. Try again in a few minutes.' }, 409)

  const { data: removed, error: delErr } = await supabase.from('scans')
    .delete().eq('id', id).eq('user_id', user.id).select('id').maybeSingle()
  if (delErr) throw delErr
  if (!removed) return ctx.json({ success: false, message: 'Scan not found.' }, 404)

  // The page it published (if any) now says "removed" instead of "not found".
  await recordTombstones(supabase, [row.verification_code])

  for (const key of [row.resume_path, row.resume_ats_path, row.resume_pdf_path]) {
    if (!key) continue
    try { await ctx.env.RESUMES_BUCKET.delete(key) }
    catch (e) { console.error(`deleteScan: failed to delete R2 object ${key} for scan ${id}:`, e.message) }
  }

  try {
    const { data: u } = await supabase.from('users').select('saved_profile').eq('id', user.id).maybeSingle()
    if (u?.saved_profile?.sourceScanId === id)
      warnOnError(await supabase.from('users')
        .update({ saved_profile: { ...u.saved_profile, sourceScanId: null } }).eq('id', user.id), 'deleteScan: clear saved-profile source')
  } catch (e) { console.error('deleteScan: saved-profile pointer:', e.message) }

  return ctx.json({ success: true, message: 'Scan deleted.' })
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
// BUG (comment corrected, behavior unchanged): the paragraph above describes
// an architecture this function doesn't actually implement — the AI-blend
// scoring call a few lines below (scoreResumeWithAI) runs unconditionally,
// for every scan regardless of inputMode, including file-mode. Every
// anonymous scan (1/hr) and every free logged-in scan (3/day) makes a real
// Claude API call today; there is no free-scan path that avoids it. Left
// uncorrected, anyone doing cost/capacity planning off this comment would
// be working from a materially wrong assumption. Not changing the scoring
// behavior itself here — whether free scans SHOULD skip the AI blend is a
// product/cost tradeoff, not something to decide unilaterally while fixing
// a stale comment.

async function runAtsScan(env, supabase, scanId) {
  let scanForRefund = null
  try {
    warnOnError(await supabase.from('scans').update({ status: 'SCANNING' }).eq('id', scanId), 'runAtsScan: mark SCANNING')
    const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).single()
    if (error) throw error
    const scan = scanRowToCamel(row)
    scanForRefund = scan

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
        // Only a failure of OUR structuring call is refunded — "tell us more"
        // (too little text) is the person's to fix, and refunding those would
        // make an unlimited free retry loop.
        if (/could not structure/i.test(parseErrorMessage || '')) await refundScanQuota(supabase, scan, 'runAtsScan: quota refund (structure failure)')
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
      // AUDIT FIX (bug): see renderStructuredResumeText's comment above —
      // this used to be a direct resumeParser.serializeResumeData(resumeData)
      // call, scoring synthetic text instead of the real generated document.
      rawResumeText = await renderStructuredResumeText(resumeData)

      // Persist the structured data now. This is a functional requirement
      // for brain-dump mode specifically — generateFix/generateBadge need
      // this exact structured object later, and unlike file-mode there is
      // no R2 object to re-derive it from a second time. (Phase 2 will
      // additionally persist rewrittenResumeData, and do the equivalent
      // capture for file-mode scans, purely for the diff-view feature —
      // this write here is separate from that and would exist even if
      // Phase 2 never shipped.)
      //
      // BUG FIX (audit): candidate_first_name used to only get set inside
      // generateFix/generateBadge — i.e. only once a Fix or Badge was
      // purchased. getScanHistory's ?search= filter matches against this
      // column specifically so brain-dump/saved-profile scans (which have
      // no resume_original_name) are still findable by name — but since
      // most free scans are never purchased, that search silently did
      // nothing for the majority of the exact scans it exists to help.
      // resumeData.name is already sitting right here, already paid for
      // (this Claude call already ran), so persisting it costs nothing extra.
      // Checked: generateFix/generateBadge read original_resume_data back
      // and have no other source for it.
      must(await supabase.from('scans').update({
        original_resume_data: resumeData,
        candidate_first_name: candidateFirstNameFrom(resumeData)
      }).eq('id', scanId), 'runAtsScan: persist structured resume')
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
        await refundScanQuota(supabase, scan, 'runAtsScan: quota refund (saved profile missing)')
        return
      }
      // AUDIT FIX (bug): same WYSIWYG fix as the brain_dump branch above —
      // see renderStructuredResumeText's comment.
      rawResumeText = await renderStructuredResumeText(scan.originalResumeData)
      // BUG FIX (audit): same candidate_first_name gap as the brain_dump
      // branch above — saved-profile scans never got it set until a Fix/
      // Badge was purchased either, for the same reason (getScanHistory's
      // name search silently doing nothing for the common, never-purchased
      // case). No new call needed — originalResumeData already came from
      // users.saved_profile with no Claude round trip involved.
      warnOnError(await supabase.from('scans').update({
        candidate_first_name: candidateFirstNameFrom(scan.originalResumeData)
      }).eq('id', scanId), 'runAtsScan: persist candidate name')
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
      // No Claude call was made and no result was produced — give the slot back
      // so the person can retry with a usable file.
      await refundScanQuota(supabase, scan, 'runAtsScan: quota refund (unparseable resume)')
      return
    }

    // AUDIT FIX (Auth/Scan round): was MAX_RESUME_CHARS (8000 — the brain-dump
    // box size). A 3-page resume is 8-10k characters; everything past the cap
    // (Education, Skills, older roles) was invisible to scoring and the
    // section check reported it missing (measured: sections 85 -> 43).
    const resumeText = rawResumeText.slice(0, c.MAX_RESUME_TEXT_CHARS)
    const jdText     = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const ruleResult = atsService.scoreResume(resumeText, jdText)

    // AI blend — 70% rule + 30% AI, never fail scan if AI unavailable
    const aiResult = await claudeService.scoreResumeWithAI(env, resumeText, jdText)
    const { finalScore, aiMissingKeywords } = blendAiScore(ruleResult.score, aiResult, 'runAtsScan')

    // Checked: this is THE write that completes the scan. If it fails the
    // row stays SCANNING, so it must throw into the handler below (which
    // marks the scan ERROR immediately) instead of the user waiting on a
    // scan that will never finish.
    must(await supabase.from('scans').update({
      ats_score:       finalScore,
      passed:          finalScore >= c.ATS_PASS_THRESHOLD,
      keyword_score:   ruleResult.keywordScore,
      format_score:    ruleResult.formatScore,
      sections_score:  ruleResult.sectionsScore,
      content_score:   ruleResult.contentScore,
      full_ats_report: { ...ruleResult.detail, aiMissingKeywords },
      role_category:   atsService.detectRoleCategory(jdText),
      seniority_level: atsService.detectSeniority(jdText),
      scan_completed_at: new Date().toISOString(),
      status: finalScore >= c.ATS_PASS_THRESHOLD ? 'COMPLETE_PASS' : 'COMPLETE_FAIL'
    }).eq('id', scanId), 'runAtsScan: save result')

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
    } else if (scan.inputMode === 'brain_dump' && scan.contactEmail) {
      // AUDIT FIX (feature gap — section audit "generate a resume from
      // scratch"): an anonymous brain-dump submitter has no account, so the
      // logged-in branch above never fires for them — they previously got
      // NO email at all, despite ScanForm.jsx explicitly collecting an email
      // address from them for exactly this kind of recovery scenario ("so
      // your resume header isn't blank" undersold what it should also be
      // used for). Without this, closing the tab / losing the localStorage
      // anon_token means losing access to a resume they just spent real
      // effort typing out, with a validated email sitting right there on
      // the row unused. Embeds the scan's own anon_token as a magic link —
      // this is not a third-party address, it's the address the person
      // themselves just typed into this exact form, so it's the same trust
      // boundary as any "here's your link" confirmation email.
      try {
        await emailService.sendAnonScanResult(
          env, supabase, scan.contactEmail, scan.contactName || 'there',
          scanId, scan.anonToken, finalScore, finalScore >= c.ATS_PASS_THRESHOLD
        )
      } catch (e) { console.error('Anon scan email:', e.message) }
    }
  } catch (err) {
    console.error('runAtsScan error:', err.message)
    // supabase-js query builders are thenable but not real Promises — .catch()
    // doesn't exist on them directly, must use a real try/catch instead.
    try {
      await supabase.from('scans').update({ status: 'ERROR' }).eq('id', scanId)
    } catch (_) {}
    // An unexpected throw mid-pipeline is our fault, not the person's.
    try { await refundScanQuota(supabase, scanForRefund, 'runAtsScan: quota refund (unexpected error)') } catch (_) {}
  }
}

// POST /api/scan/:id/regenerate-pdf
// FEATURE GAP CLOSED (Auth/Scan round): a failed PDF render is deliberately
// non-fatal (the DOCX is delivered and paid for) — but nothing ever recorded
// it, surfaced it, or let the customer recover it. The PDF is the file most
// candidates actually send to employers, so a person whose render failed was
// stuck: the page offered "Download PDF" and answered "File not ready yet."
// forever. This re-renders the PDF from the delivered structured data, adds
// it to the existing delivery, and touches nothing else (the DOCX, its hash,
// the verification code and the score are unchanged).
async function regeneratePdf(ctx) {
  const user = ctx.get('user')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)
  if (!scan || scan.userId !== user.id)
    return ctx.json({ success: false, message: 'Access denied.' }, 403)
  if (!scan.fixPurchased || scan.status !== 'FIX_DELIVERED')
    return ctx.json({ success: false, message: 'Your resume must be delivered before a PDF can be generated.' }, 400)
  if (scan.resumePdfPath)
    return ctx.json({ success: true, data: { alreadyAvailable: true } })
  const data = scan.rewrittenResumeData || scan.originalResumeData
  if (!data)
    return ctx.json({ success: false, message: 'No resume content is stored for this scan.' }, 400)

  const isPlain = scan.fixTier === 'FIX_PLAIN'
  const verificationUrl = isPlain ? null : (scan.verificationUrl || null)
  const credentialVerified = !isPlain && typeof scan.fixAtsScore === 'number' && scan.fixAtsScore >= c.ATS_BADGE_THRESHOLD
  const designTokens = designService.getDesignTokens(scan.userId || scan.id, scan.id, scan.roleCategory)
  const version = cryptoLib.randomToken(6)
  const { pdfKey, pdfHash, error: pdfError } = await renderDeliveredPdf(ctx.env, scan.id, data, designTokens, verificationUrl, credentialVerified, version, { hash: !isPlain })
  if (!pdfKey)
    return ctx.json({ success: false, message: 'We couldn\'t generate the PDF just now. Please try again in a minute.', detail: pdfError }, 502)

  // Only attach it if nobody else did in the meantime (double-click, two tabs).
  const { data: updated, error: updErr } = await supabase.from('scans')
    .update({ resume_pdf_path: pdfKey, resume_pdf_hash: pdfHash })
    .eq('id', scan.id).is('resume_pdf_path', null).select('id')
  if (updErr) {
    await deleteSuperseded(ctx.env, [pdfKey], [])
    throw updErr
  }
  if (Array.isArray(updated) && updated.length === 0) {
    await deleteSuperseded(ctx.env, [pdfKey], [])
    return ctx.json({ success: true, data: { alreadyAvailable: true } })
  }
  return ctx.json({ success: true, data: { alreadyAvailable: false } })
}

// ─── generateFix — AI rewrite + ATS DOCX + beautiful PDF + credential ────────

// ─── Section 7 (Verify) audit: deliverable storage helpers ───────────────────

// Hashes of a superseded delivery, kept so a hiring manager holding an OLDER
// file is told "earlier version", not "modified" (see verify.controller).
function nextHashHistory(scan) {
  const history = Array.isArray(scan.resumeHashHistory) ? [...scan.resumeHashHistory] : []
  if ((scan.resumeHash || scan.resumePdfHash) &&
      !history.some(h => h.docx === (scan.resumeHash || null) && h.pdf === (scan.resumePdfHash || null)))
    history.push({ docx: scan.resumeHash || null, pdf: scan.resumePdfHash || null, at: scan.verifiedAt || scan.fixGeneratedAt || null })
  return history.slice(-20)
}

// Best-effort removal of objects the row no longer points at. Runs only AFTER
// the row has been repointed — until then the old object is still the one the
// public page is verifying against.
async function deleteSuperseded(env, oldKeys, keepKeys) {
  for (const key of oldKeys) {
    if (!key || keepKeys.includes(key)) continue
    try { await env.RESUMES_BUCKET.delete(key) } catch (err) { console.error(`[WARN] could not delete superseded ${key}:`, err.message) }
  }
}

// Scores a candidate resume text the SAME way a fresh scan does: rule score
// blended with the AI opinion (same weights, same clamping). AUDIT FIX
// (Auth/Scan round): the fix pipeline used to score candidates rule-ONLY while
// the number the customer saw before paying (ats_score) is the 70/30 blend —
// so "before" and "after" were on different scales, and "Verified" meant
// different things by tier (BADGE: blended >= 80; FIX: rule-only >= 80). One
// resume could be eligible for the credential through one route and not the
// other. If the AI call fails this degrades to rule-only, exactly as a scan does.
async function scoreLikeScan(env, text, jdText, logLabel) {
  const rule = atsService.scoreResume(text, jdText)
  let aiResult = { success: false }
  try { aiResult = await claudeService.scoreResumeWithAI(env, text, jdText) }
  catch (e) { console.error(`${logLabel} AI score call failed, using rule-only score:`, e.message) }
  const { finalScore } = blendAiScore(rule.score, aiResult, logLabel)
  return { ...rule, score: finalScore, ruleScore: rule.score }
}

// Renders the designed PDF for a delivered resume and stores it. Shared by
// generateFix, generateBadge and regeneratePdf so all three behave alike. A
// failure never throws (the DOCX is already delivered and paid for) but IS
// reported, and the PDF render itself gets one retry — Browser Rendering
// sessions fail transiently (concurrency limits, cold starts).
async function renderDeliveredPdf(env, scanId, data, designTokens, verificationUrl, verified, version, { hash }) {
  const htmlResult = await claudeService.generateBeautifulResumeHTML(env, data, designTokens, verificationUrl, { verified })
  if (!htmlResult.success) {
    console.error(`[WARN] HTML resume generation failed for ${scanId}: ${htmlResult.error || 'unknown'}`)
    return { pdfKey: null, pdfHash: null, error: htmlResult.error || 'HTML generation failed' }
  }
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const pdfBytes = await pdfService.generateResumePDF(env, htmlResult.data)
      const pdfKey = storage.beautifulPdfKey(scanId, version)
      await env.RESUMES_BUCKET.put(pdfKey, pdfBytes, { httpMetadata: { contentType: 'application/pdf' } })
      // The PDF is the file candidates email to hiring managers — it needs a
      // fingerprint too, or the file employers actually receive is unverifiable.
      return { pdfKey, pdfHash: hash ? await badgeService.hashBytes(pdfBytes) : null, error: null }
    } catch (pdfErr) {
      lastErr = pdfErr
      // PDF failure must not kill delivery — DOCX is already generated and paid for
      console.error(`[WARN] PDF generation failed for ${scanId} (attempt ${attempt}):`, pdfErr.message)
    }
  }
  return { pdfKey: null, pdfHash: null, error: lastErr ? lastErr.message : 'PDF generation failed' }
}

async function generateFix(env, supabase, scanId) {
  // True once this scan already HAS a delivered fix and this run is a retry on
  // top of it — a crash then must not take the delivered fix away (see catch).
  let priorDelivery = false
  try {
    await supabase.from('scans').update({ status: 'FIX_GENERATING' }).eq('id', scanId)
    const { scan, user } = await getScanWithUser(supabase, scanId)
    priorDelivery = !!scan.resumeAtsPath && scan.fixRetryCount > 0

    // `originalData` is what the resume WAS — the user's own content. It is
    // what gets persisted as original_resume_data and what the fabrication
    // guard compares against, on EVERY round. `resumeData` is only what this
    // round's rewrite starts FROM (the previous rewrite, on a retry).
    let originalData

    if (scan.inputMode === 'brain_dump' || scan.inputMode === 'saved_profile') {
      // PHASE 1 (brain_dump) / PHASE 4 (saved_profile): both non-file modes
      // reuse structured data already persisted on the scan row rather
      // than re-deriving it — cheaper, and guarantees the fix rewrites
      // from the exact same structured object that was scored. The two
      // modes differ only in HOW that data got there (a structuring Claude
      // call vs a direct copy from users.saved_profile); by this point the
      // sourcing logic is identical either way.
      originalData = scan.originalResumeData
      if (!originalData)
        throw new Error(`${scan.inputMode} scan has no structured data — runAtsScan did not complete successfully`)
    } else if (scan.originalResumeData) {
      // AUDIT FIX (Auth/Scan round): a retry (or an at-least-once queue
      // redelivery) re-fetched the file and paid for a fresh Claude parse
      // whose result was then thrown away. The structure persisted by the
      // first run IS the original — reuse it.
      originalData = scan.originalResumeData
    } else {
      const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
      if (!obj) throw new Error('Resume file missing from storage')
      const resumeBytes = new Uint8Array(await obj.arrayBuffer())

      const parsed = await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)
      if (parsed.parseError || !parsed.resumeData) throw new Error(parsed.parseErrorMessage || 'Parse failed')
      originalData = parsed.resumeData
    }

    // Retries build on the LATEST delivered rewrite, not the original
    // upload — this is what "each retry uses the latest generated resume
    // plus feedback" means in practice. isRetry is just "has this scan's
    // retry counter already been incremented past 0" (see retryFix below,
    // which increments it before enqueueing).
    //
    // AUDIT FIX (Auth/Scan round): this used to REASSIGN the one variable that
    // was later written back as original_resume_data — so after any retry the
    // "original" stored (and shown by DiffView, and offered to "save profile")
    // was the previous rewrite, not the user's resume.
    const isRetry = scan.fixRetryCount > 0
    let resumeData = originalData
    if (isRetry && scan.rewrittenResumeData) resumeData = scan.rewrittenResumeData

    const jdText = (scan.jobDescriptionText || '').slice(0, c.MAX_JD_CHARS)
    const candidateFirstName = candidateFirstNameFrom(resumeData)
    // DOCX_MIME is now module-level — see top of file.

    // Verification code/URL computed BEFORE the loop now (was previously
    // computed after) — every candidate's scoring docx and the final
    // delivered docx need to embed the exact same URL, both so scoring is
    // consistent with what's actually delivered, and so retries continue
    // reusing the existing link (see comment below) rather than orphaning
    // it partway through a round.
    //
    // FIX_PLAIN issues no credential at all — code/verificationUrl stay
    // null, and docxService/generateBeautifulResumeHTML both know to omit
    // the credential line entirely rather than render a broken one (see
    // their null-verificationUrl handling).
    const isPlain = scan.fixTier === 'FIX_PLAIN'
    // SECTION 7/8 AUDIT: reuse an existing code whenever the scan already has one,
    // not only on an explicit retry. Queue delivery is at-least-once, so the same
    // generation can legitimately run twice; a fresh code on the second run left
    // the first run's already-emailed document pointing at a page that no longer
    // exists.
    const code            = isPlain ? null : (scan.verificationCode ? scan.verificationCode : await badgeService.generateShortCode(supabase))
    const verificationUrl = isPlain ? null : (scan.verificationUrl  ? scan.verificationUrl  : badgeService.buildVerificationUrl(env, code))

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
      // Rule-based only on purpose: this is just to regenerate the weak-areas text.
      const startingScore = atsService.scoreResume(startingText, jdText)
      lastFeedback = {
        score: scan.fixAtsScore,
        threshold: c.ATS_BADGE_THRESHOLD,
        weakAreas: atsService.describeWeakAreas(startingScore)
      }
    }

    for (let attempt = 1; attempt <= c.MAX_FIX_ATTEMPTS; attempt++) {
      const rewriteResult = await claudeService.rewriteResumeContent(env, resumeData, jdText, lastFeedback, originalData)
      if (!rewriteResult.success) {
        // AUDIT FIX: FABRICATION_DETECTED used to hit the same `break` as a
        // genuine API/parse failure — but it isn't one. It means THIS ONE
        // candidate got caught inventing or dropping an employer; it says
        // nothing about whether another attempt would too. Treating it as
        // fatal meant a single fabrication catch on attempt 1 (with no
        // prior successful attempt to fall back on) silently delivered the
        // user's UNTOUCHED ORIGINAL resume as their paid "Fix" — bestScore
        // stayed -1, bestData stayed the original resumeData, and nothing
        // ever surfaced that no rewrite actually happened. Feeding it back
        // as explicit feedback and continuing to the next attempt (if any
        // remain) gives Claude a chance to produce a clean rewrite instead
        // of ending the whole fix over one bad candidate. Genuine hard
        // failures (PARSE_FAIL, RESPONSE_TRUNCATED, a raw API error) still
        // break immediately — retrying those isn't expected to help within
        // the same request, which is what the original comment was about.
        if (rewriteResult.error === 'FABRICATION_DETECTED' && attempt < c.MAX_FIX_ATTEMPTS) {
          lastFeedback = {
            score: null,
            threshold: c.ATS_BADGE_THRESHOLD,
            weakAreas: ['Previous attempt changed facts it must not: it added or dropped a company, institution or project, gave a job a higher or different title, changed employment/education dates, upgraded a degree, or added a certification. Rewrite using ONLY the employers, institutions, titles, dates, degrees and certifications already present — do not add, remove, or alter any.']
          }
          continue
        }
        break  // API/parse failure (or fabrication with no attempts left) — nothing to score, stop retrying
      }

      const candidateData = rewriteResult.data
      const candidateQuantificationPrompts = rewriteResult.quantificationOpportunities || []
      // Score the REAL generated file, not a synthetic text approximation —
      // see the WYSIWYG comment above.
      const candidateDocxBytes = await docxService.generateAtsDocx(candidateData, verificationUrl)
      const candidateText = await resumeParser.extractText(candidateDocxBytes, DOCX_MIME)
      const candidateScore = await scoreLikeScan(env, candidateText, jdText, 'generateFix')

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
    //
    // AUDIT FIX (feature gap — Scan/ATS section audit, round 2): bestScore
    // staying at -1 means something more specific than "scored low" — it
    // means NOTHING this loop produced was ever usable (every attempt hit a
    // raw API error, a truncated/malformed response, or fabricated content
    // with no attempts left to retry). In that case finalData === resumeData
    // — the user's ORIGINAL, unmodified resume — is what gets delivered as
    // their paid "Fix", with no distinguishing signal anywhere: the delivered
    // email/UI previously treated this identically to a legitimate rewrite
    // that simply landed under the badge threshold. The existing safety net
    // (a free credit) only ever fired once a user manually exhausted
    // MAX_FIX_RETRIES clicking "Try Again" — on the very FIRST generateFix
    // run, a pure system-side failure cost the user a full purchase with
    // zero automatic compensation and zero explanation. rewriteFailed is
    // persisted below so the frontend can show an honest "we hit a system
    // issue, this is your original resume unchanged" message instead of the
    // normal "below threshold" copy, and a credit is granted immediately —
    // every time this happens, not just once retries run out — since each
    // occurrence is a real failure on Passthrough's side, not a quality
    // shortfall the retry loop exists to iterate on.
    const rewriteFailed = bestScore < 0
    const fixAtsScore = bestScore >= 0
      ? bestScore
      : (await scoreLikeScan(
          env,
          await resumeParser.extractText(await docxService.generateAtsDocx(resumeData, verificationUrl), DOCX_MIME),
          jdText,
          'generateFix (original fallback)'
        )).score

    if (rewriteFailed && scan.userId) {
      // A total rewrite failure, not a quality shortfall — compensate every
      // time it happens rather than waiting for retries to run out. Same
      // must()+owner-alert hardening as the exhausted-retries branch below,
      // so a credit that fails to write is never silently lost either way.
      try {
        must(await supabase.rpc('increment_free_fix_credits', { p_user_id: scan.userId }), 'grant free fix credit (rewrite failure)')
      } catch (creditErr) {
        console.error(`[CRITICAL] Failed to grant fix credit (rewrite failure) to ${scan.userId}:`, creditErr.message)
        try {
          await emailService.sendOwnerAlert(env, 'Free fix credit NOT granted',
            `userId: ${scan.userId}\nscanId: ${scanId}\nerror: ${creditErr.message}\n\nEvery rewrite attempt hard-failed (rewriteFailed); the compensating free credit was not written. Restore it with increment_free_fix_credits.`)
        } catch (_) {}
      }
    } else if (isRetry && scan.fixRetryCount >= c.MAX_FIX_RETRIES && fixAtsScore < c.ATS_BADGE_THRESHOLD && scan.userId) {
      // Retries are exhausted (this was the last one allowed) and still
      // short of the badge threshold — grant a free credit for next time
      // rather than leaving the user with nothing to show for it. Mutually
      // exclusive with the rewriteFailed branch above so a total failure on
      // the final retry can never grant two credits for one occurrence.
      try {
        must(await supabase.rpc('increment_free_fix_credits', { p_user_id: scan.userId }), 'grant free fix credit')
      } catch (creditErr) {
        console.error(`[CRITICAL] Failed to grant fix credit to ${scan.userId}:`, creditErr.message)
        try {
          await emailService.sendOwnerAlert(env, 'Free fix credit NOT granted',
            `userId: ${scan.userId}\nscanId: ${scanId}\nerror: ${creditErr.message}\n\nRetries were exhausted below the badge threshold; the promised free credit was not written. Restore it with increment_free_fix_credits.`)
        } catch (_) {}
      }
    }

    // Reuse the winning attempt's already-generated docx bytes instead of
    // generating a 4th time — bestDocxBytes is set whenever a NEW attempt in
    // THIS round beats the running best. The one case it's still null: a
    // retry round where every new attempt scored worse than the carried-
    // forward previous-round result, so bestData never changed from its
    // initial value and there's nothing new to reuse — regenerate in that
    // one case only.
    // SECTION 7 AUDIT (bug + product decision): the credential wording must match
    // what the public page will say. A rewrite that finishes under the
    // threshold used to ship a document reading "Passthrough Verified: <link>"
    // (and a PDF with a ✓ Passthrough Verified badge) pointing at a page that says
    // "Below the Passthrough Verified threshold" — a false claim, printed on a
    // resume the candidate sends to employers. Below the threshold the link is
    // kept (it's still the scan report) but labelled honestly, everywhere.
    // The loop above scored the "Verified"-labelled document; the label is one
    // word of header text, so the stored score is deliberately NOT re-derived.
    const credentialVerified = !isPlain && fixAtsScore >= c.ATS_BADGE_THRESHOLD
    const docxBytes = (verificationUrl && !credentialVerified)
      ? await docxService.generateAtsDocx(finalData, verificationUrl, { verified: false })
      : (bestDocxBytes || await docxService.generateAtsDocx(finalData, verificationUrl))

    // Fresh key per generation: the previously delivered object stays intact
    // (and is what the public page keeps verifying) until the DB row is
    // repointed below. See config/storage.js.
    const version = cryptoLib.randomToken(6)
    const docxKey = storage.atsDocxKey(scanId, version)
    await env.RESUMES_BUCKET.put(docxKey, docxBytes, {
      httpMetadata: { contentType: DOCX_MIME }
    })
    const resumeHash = isPlain ? null : await badgeService.hashBytes(docxBytes)

    const designTokens = designService.getDesignTokens(scan.userId || scanId, scanId, scan.roleCategory)
    const { pdfKey, pdfHash } = await renderDeliveredPdf(env, scanId, finalData, designTokens, verificationUrl, credentialVerified, version, { hash: !isPlain })

    const { error: deliverErr } = await supabase.from('scans').update({
      candidate_first_name: candidateFirstName,
      resume_ats_path:      docxKey,
      resume_pdf_path:      pdfKey,
      resume_pdf_hash:      pdfHash,
      resume_hash_history:  isPlain ? [] : nextHashHistory(scan),
      fix_ats_score:        fixAtsScore,
      // Reset every generation — this reflects THIS attempt's outcome only,
      // never a stale value from an earlier round on the same scan (a
      // subsequent retry that succeeds must clear it, not just add to it).
      rewrite_failed:       rewriteFailed,
      fix_generated_at:     new Date().toISOString(),
      verification_code:    code,
      verification_url:     verificationUrl,
      resume_hash:           resumeHash,
      verified_at:            isPlain ? null : new Date().toISOString(),
      // PHASE 2: persist both structured objects for the diff view.
      // resumeData is what the resume WAS (already parsed above, from R2 for
      // file-mode or scan.originalResumeData for brain-dump mode) — writing
      // it here is a no-op for brain-dump mode (already persisted by
      // runAtsScan) and the first persistence for file-mode. finalData is
      // what the AI rewrite produced, OR equals resumeData unchanged if the
      // rewrite failed and generateFix fell back to the original content —
      // in that fallback case the two objects are identical and the diff
      // view will correctly render "no changes," which is the honest signal.
      original_resume_data:  originalData,
      rewritten_resume_data: finalData,
      // PHASE 3: static suggestions only — no regeneration loop in v1. See
      // QuantificationPrompts.jsx for how these render.
      quantification_prompts: quantificationPrompts,
      status: 'FIX_DELIVERED'
    }).eq('id', scanId)
    // This write was never checked: a failed update used to fall straight
    // through to "delivered" emails for a scan still stuck at FIX_GENERATING.
    if (deliverErr) throw deliverErr
    await deleteSuperseded(env, [scan.resumeAtsPath, scan.resumePdfPath], [docxKey, pdfKey])

    if (user) {
      try {
        if (isPlain) await emailService.sendFixDeliveredPlain(env, supabase, user.email, user.name)
        else         await emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl, credentialVerified)
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
    if (priorDelivery) {
      // AUDIT FIX (Auth/Scan round): a crash during a RETRY round used to set
      // ERROR on a scan whose previous fix was already delivered — the results
      // page hides everything for ERROR, and (for a paid scan) told the person
      // the scan "failed", although their delivered files were still there.
      // The earlier delivery is untouched (a retry only repoints the row on
      // success), so put the status back AND hand the retry back — the same
      // atomic revert retryFix uses when it can't enqueue. The owner alert
      // above still fires.
      try {
        must(await supabase.rpc('revert_fix_retry', { p_scan_id: scanId }), 'revert fix retry (failed retry round)')
      } catch (revertErr) {
        console.error(`[CRITICAL] generateFix ${scanId}: revert_fix_retry failed:`, revertErr.message)
        try { await supabase.from('scans').update({ status: 'FIX_DELIVERED' }).eq('id', scanId) } catch (_) {}
      }
      return { success: false, error: err.message }
    }
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
  // True once this scan already HAS a delivered badge and this run is a
  // redelivery on top of it (queues are at-least-once) — a crash then must
  // not take the delivered badge away (see catch). Unlike generateFix there
  // is no retry counter to undo here: badges are one-shot, so this is just
  // "was a docx already sitting on this row before this run started".
  let priorDelivery = false
  try {
    await supabase.from('scans').update({ status: 'FIX_GENERATING' }).eq('id', scanId)
    const { scan, user } = await getScanWithUser(supabase, scanId)
    priorDelivery = !!scan.resumeAtsPath

    let finalData

    // AUDIT FIX (Auth/Scan round): this used to fall back to an empty
    // "Candidate" shell — or, for a file, a shell whose skills were the first
    // 20 raw words — whenever structured data was missing or the parse failed,
    // and then deliver THAT as the paid, "Passthrough Verified" resume (score
    // 80+, hash and all) with no error and no alert. A credential attached to
    // a document that is not the person's resume is worse than a failed job:
    // it is now a failure, which takes the normal path — status ERROR, the
    // failure email, the owner alert, and the payment-sweep requeue.
    if (scan.inputMode === 'brain_dump' || scan.inputMode === 'saved_profile') {
      finalData = scan.originalResumeData
      if (!finalData)
        throw new Error(`${scan.inputMode} scan has no structured data — runAtsScan did not complete successfully`)
    } else if (scan.originalResumeData) {
      // Reuse the structure persisted by an earlier run (redelivery) instead
      // of paying for another Claude parse.
      finalData = scan.originalResumeData
    } else {
      const obj = await env.RESUMES_BUCKET.get(scan.resumePath)
      if (!obj) throw new Error('Resume file missing from storage')
      const resumeBytes = new Uint8Array(await obj.arrayBuffer())

      const { resumeData, parseError, parseErrorMessage } = await resumeParser.parse(env, resumeBytes, scan.resumeMimeType)
      if (parseError || !resumeData) throw new Error(parseErrorMessage || 'Parse failed')
      finalData = resumeData
    }

    // Use finalData.name — correct source after fallback
    const candidateFirstName = candidateFirstNameFrom(finalData)
    // Same reasoning as generateFix: never orphan an already-delivered link.
    const code            = scan.verificationCode || await badgeService.generateShortCode(supabase)
    const verificationUrl = badgeService.buildVerificationUrl(env, code)

    // Pass verificationUrl — not hardcoded domain
    // Versioned keys + hashes for BOTH files — see generateFix and config/storage.js.
    const docxBytes = await docxService.generateAtsDocx(finalData, verificationUrl)
    const version = cryptoLib.randomToken(6)
    const docxKey = storage.atsDocxKey(scanId, version)
    await env.RESUMES_BUCKET.put(docxKey, docxBytes, {
      httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    })
    const resumeHash = await badgeService.hashBytes(docxBytes)

    const designTokens = designService.getDesignTokens(scan.userId || scanId, scanId, scan.roleCategory)
    // A badge purchase requires a score at/above the threshold (initiateFix), so
    // the credential wording is always the verified one here.
    const { pdfKey, pdfHash } = await renderDeliveredPdf(env, scanId, finalData, designTokens, verificationUrl, true, version, { hash: true })

    const { error: deliverErr } = await supabase.from('scans').update({
      candidate_first_name: candidateFirstName,
      resume_ats_path:      docxKey,
      resume_pdf_path:      pdfKey,
      resume_pdf_hash:      pdfHash,
      resume_hash_history:  nextHashHistory(scan),
      fix_ats_score:        scan.atsScore,
      fix_generated_at:     new Date().toISOString(),
      verification_code:    code,
      verification_url:     verificationUrl,
      resume_hash:           resumeHash,
      verified_at:            new Date().toISOString(),
      // PHASE 2: persist the structured content for the diff view. Note the
      // naming here — `finalData` in this function is the ORIGINAL content,
      // never a rewrite: generateBadge
      // never calls rewriteResumeContent, by design, since badge-only
      // purchases don't include the AI rewrite. rewritten_resume_data is
      // deliberately left untouched (stays null) — DiffView.jsx uses that
      // null to render "credential only, no content changes" instead of a
      // diff that would misleadingly imply a rewrite happened.
      original_resume_data:  finalData,
      status: 'FIX_DELIVERED'
    }).eq('id', scanId)
    if (deliverErr) throw deliverErr
    await deleteSuperseded(env, [scan.resumeAtsPath, scan.resumePdfPath], [docxKey, pdfKey])

    if (user) {
      try {
        await emailService.sendFixDelivered(env, supabase, user.email, user.name, code, verificationUrl, true)
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
    if (priorDelivery) {
      // AUDIT FIX (Auth/Scan round): same class of bug generateFix already
      // guards against — a crash on a redelivered job used to stamp ERROR
      // over a scan whose badge was already successfully delivered, hiding
      // real, valid, paid-for files behind a "failed" status. The earlier
      // delivery is untouched (this function only repoints the row on
      // success), so put status back rather than clobber it. Guarded on
      // status still being FIX_GENERATING so a late/duplicate revert can't
      // stomp on an unrelated in-flight job. Deliberately no failure email —
      // the customer's delivered badge was never actually lost.
      try {
        await supabase.from('scans').update({ status: 'FIX_DELIVERED' }).eq('id', scanId).eq('status', 'FIX_GENERATING')
      } catch (revertErr) {
        console.error(`[CRITICAL] generateBadge ${scanId}: status revert failed:`, revertErr.message)
      }
      return { success: false, error: err.message }
    }
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
  createScan, getScanStatus, getScan, initiateFix, redeemCredit, retryFix, regeneratePdf, updateVerifyVisibility, downloadFile, getScanHistory, deleteScan,
  updateResumeData, downloadDraft,  // section audit: "generate a resume from scratch"
  runAtsScan, generateFix, generateBadge  // exported for webhook + payments + cron
}
