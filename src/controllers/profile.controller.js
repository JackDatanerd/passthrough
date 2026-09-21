// Phase 4 — profile reuse. Three endpoints, all auth-required.
//
// SECURITY NOTE on saveProfile: the request body is { scanId }, never raw
// resume data. The server looks up that scan (verifying ownership), reads
// ITS original_resume_data, and copies that into users.saved_profile. This
// is deliberate — accepting arbitrary client-supplied JSON here would let a
// malicious or buggy client inject unvalidated content into saved_profile,
// which later gets rendered into a DOCX/PDF for a completely different scan.
// Routing through an owned scan means the only data that can ever become a
// saved profile is data that already passed through Claude's structuring
// and detectFabrication() checks. Same trust posture as the rest of the
// app — never trust a client-supplied payload where a server-side lookup
// can derive the same value safely (see payments.controller.js's amount
// calculation for the same pattern applied to pricing).

const { getSupabase } = require('../config/supabase')
const { scanRowToCamel } = require('../lib/mappers')
const { UUID_RE } = require('../middleware/validateUuidParam')

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
  const summary = saved?.resumeData ? {
    name:         saved.resumeData.name || null,
    roleCategory: saved.roleCategory || null
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
  const body = await c.req.json()
  const scanId = body.scanId
  if (!scanId) return c.json({ success: false, message: 'scanId required.' }, 400)
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

module.exports = { getProfile, saveProfile, deleteProfile }
