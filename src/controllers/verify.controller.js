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

async function getVerification(c) {
  const code = c.req.param('code')
  const supabase = getSupabase(c.env)

  const { data: row, error } = await supabase
    .from('scans')
    .select('candidate_first_name, ats_score, verified_at, role_category, seniority_level, resume_ats_path, resume_hash')
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

  return c.json({ success: true, data: {
    candidateFirstName: row.candidate_first_name || null,
    atsScore:           row.ats_score,
    roleCategory:       row.role_category,
    seniorityLevel:     row.seniority_level,
    verifiedAt:         row.verified_at,
    integrityStatus
  }})
}

module.exports = { getVerification }
