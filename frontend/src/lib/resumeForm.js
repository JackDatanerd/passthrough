// Pure helpers for the from-scratch resume form (kept out of the components so they can be unit-tested).

// Does the hand-filled structured form carry anything worth scoring? (Mirrors the server's
// hasResumeContent in lib/resumeData.js, which is the authority.)
export const filled = v => typeof v === 'string' && v.trim()
export function manualHasContent(d) {
  if (!d) return false
  const list = v => (Array.isArray(v) ? v : [])
  return !!(filled(d.summary)
    || list(d.experience).some(e => filled(e?.title) || filled(e?.company) || list(e?.bullets).some(filled))
    || list(d.education).some(e => filled(e?.institution) || filled(e?.degree))
    || list(d.skills).some(filled) || list(d.certifications).some(filled)
    || list(d.projects).some(p => filled(p?.name) || filled(p?.description))
    || list(d.volunteer).some(v => filled(v?.organization) || filled(v?.role)))
}

export const EMPTY_MANUAL = { name: '', email: '', phone: '', location: '', linkedin: '', portfolio: '', summary: '',
  experience: [], education: [], skills: [], certifications: [], projects: [], languages: [], awards: [], publications: [], volunteer: [] }

// What the extracted resume is missing that an employer (or an ATS parser) will look for. Plain
// observations about THIS data — nothing is guessed or filled in. Exported for tests.
export function missingHints(data) {
  const out = []
  if (!data) return out
  if (!String(data.email || '').trim()) out.push('An email address — it is the first thing an ATS parser looks for.')
  if (!String(data.phone || '').trim()) out.push('A phone number.')
  const exp = Array.isArray(data.experience) ? data.experience : []
  const undated = exp.filter(e => !String(e?.dates || '').trim()).length
  if (undated) out.push(`Dates on ${undated === 1 ? '1 role' : `${undated} roles`} — employers read missing dates as a gap.`)
  const bare = exp.filter(e => !(Array.isArray(e?.bullets) && e.bullets.some(b => String(b || '').trim()))).length
  if (bare) out.push(`What you did in ${bare === 1 ? '1 role' : `${bare} roles`} — a role with no bullets scores as empty.`)
  if (!String(data.summary || '').trim()) out.push('A short summary (optional — a paid fix writes one from what you have told us).')
  return out
}
