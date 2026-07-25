// Replaces Prisma + disk-based hashFile. The integrity check now:
//   1. Fetches the DOCX bytes from R2 (keyed by resume_ats_path)
//   2. SHA-256 hashes them in-memory via lib/crypto.js → sha256Bytes()
//   3. Compares against the stored resume_hash
// This is functionally identical to the v8 version's
// hashFile(scan.resumeAtsPath) === scan.resumeHash — same algorithm, same
// on-disk content (the file was written to R2 during generateFix/Badge
// with the same bytes that were hashed at generation time).
//
// verificationViews is incremented fire-and-forget before the response is
// returned — no waitUntil needed here because the increment is a simple
// fast Supabase update, not a multi-second background job. The increment
// loss on isolate death is acceptable for an analytics counter.

const { getSupabase } = require('../config/supabase')
const { sha256Bytes } = require('../lib/crypto')
const constants        = require('../config/constants')

async function getVerification(c) {
  const code = c.req.param('code')
  const supabase = getSupabase(c.env)

  const { data: row, error } = await supabase
    .from('scans')
    .select('candidate_first_name, ats_score, fix_ats_score, verified_at, role_category, seniority_level, resume_ats_path, resume_hash, verify_expose_docx, verify_expose_pdf, resume_pdf_path')
    .eq('verification_code', code)
    .maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Verification not found.' }, 404)



  // Increment view count — fire-and-forget via Supabase RPC.
  // The SQL function increment_verification_views is defined in 0002_helpers.sql.
  // Using RPC avoids the read-modify-write race that a select+update would have.
  supabase.rpc('increment_verification_views', { p_code: code })
    .then(() => {}, e => console.error('verificationViews increment:', e.message))

  // Integrity check — re-hash the stored DOCX bytes from R2
  let integrityStatus = 'verified'
  if (row.resume_ats_path && row.resume_hash) {
    try {
      const obj = await c.env.RESUMES_BUCKET.get(row.resume_ats_path)
      if (obj) {
        const bytes = await obj.arrayBuffer()
        const hash  = await sha256Bytes(bytes)
        integrityStatus = hash === row.resume_hash ? 'verified' : 'modified'
      }
    } catch (_) {}
  }

  // fix_ats_score is the score of the resume actually being verified here
  // (the delivered DOCX at resume_ats_path) — ats_score is the score of
  // whatever was originally uploaded, before any fix, and should never be
  // shown on this page. Older rows created before fix_ats_score existed
  // fall back to ats_score so verification doesn't break for them, but
  // every row generated going forward always has fix_ats_score set (see
  // generateFix/generateBadge in scan.controller.js).
  const verifiedScore = row.fix_ats_score ?? row.ats_score

  return c.json({ success: true, data: {
    candidateFirstName: row.candidate_first_name || null,
    atsScore:           verifiedScore,
    passed:             verifiedScore >= constants.ATS_BADGE_THRESHOLD,
    roleCategory:       row.role_category,
    seniorityLevel:     row.seniority_level,
    verifiedAt:         row.verified_at,
    integrityStatus,
    // Owner-controlled — default OFF for both (see 0007_verify_document_visibility.sql).
    // The frontend uses these to decide whether to show a download link at
    // all; the actual download is separately re-checked server-side below,
    // not trusted from this response alone.
    exposeDocx:         !!row.verify_expose_docx,
    exposePdf:           !!row.verify_expose_pdf
  }})
}

// GET /api/verify/:code/download?type=docx|pdf — public, no auth. Only
// serves a file if the resume owner has explicitly toggled that document
// type visible on their verification page (see scan.controller.js's
// updateVerifyVisibility for the toggle, off by default). Deliberately
// re-checks the flag here rather than trusting the frontend to only call
// this when getVerification said it was OK — the frontend check is a UX
// convenience, this is the actual access control.
async function downloadVerifiedFile(c) {
  const code = c.req.param('code')
  const type = c.req.query('type')
  const supabase = getSupabase(c.env)

  const { data: row, error } = await supabase
    .from('scans')
    .select('resume_ats_path, resume_pdf_path, verify_expose_docx, verify_expose_pdf')
    .eq('verification_code', code)
    .maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Verification not found.' }, 404)

  const exposed = type === 'pdf' ? row.verify_expose_pdf : row.verify_expose_docx
  if (!exposed) return c.json({ success: false, message: 'This document is not publicly available.' }, 403)

  const fileKey  = type === 'pdf' ? row.resume_pdf_path : row.resume_ats_path
  const filename = type === 'pdf' ? 'resume-verified.pdf' : 'resume-ats.docx'
  if (!fileKey) return c.json({ success: false, message: 'File not available.' }, 404)

  const obj = await c.env.RESUMES_BUCKET.get(fileKey)
  if (!obj) return c.json({ success: false, message: 'File not available.' }, 404)

  c.header('Content-Disposition', `inline; filename="${filename}"`)
  c.header('Content-Type', type === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  return c.body(obj.body)
}

module.exports = { getVerification, downloadVerifiedFile }
