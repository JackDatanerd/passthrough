// The employer's name, taken from a job posting, so a cover letter can name the company without the applicant typing it
// (the letter used to say "your team" even when the posting named the employer in its first line). Conservative on purpose:
// a wrong company in a letter is worse than none, so the name is returned only when
//   (a) the posting carries an explicit "Company: X" line (what the URL importer writes from structured data), or
//   (b) a recognisable phrase names it ("About X", "Join X", "X is hiring", "at X is looking") AND it occurs again elsewhere.
// Anything else returns null, and the letter says "your team" as before.

const clean = s => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim()
const NAME = String.raw`([A-Z][\p{L}0-9&'’.\-]*(?:[ \t]+(?:&[ \t]+)?[A-Z0-9][\p{L}0-9&'’.\-]*){0,3})`
const GENERIC = new Set(`the this our us we you your team company role position job work description overview summary
  about join careers apply benefits requirements responsibilities qualifications location remote hybrid onsite full part time
  the-team we're we’re opportunity candidate candidates employer industry business organization organisation department group`.split(/\s+/))

function plausible(name) {
  const n = clean(name).replace(/[.,;:]+$/, '')
  if (n.length < 2 || n.length > 60) return null
  const words = n.toLowerCase().split(/\s+/)
  if (words.every(w => GENERIC.has(w)) || GENERIC.has(words[0])) return null
  if (/^(?:a|an|the)\b/i.test(n)) return null
  return n
}

function companyFromPosting(text) {
  const t = String(text || '')
  if (!t) return null
  const explicit = t.match(/^\s*Company\s*:\s*(.{2,60})$/im)
  if (explicit) { const n = plausible(explicit[1]); if (n) return n }
  const patterns = [
    new RegExp(String.raw`\b[Aa]bout\s+${NAME}\s*(?:\n|:|$)`, 'u'),
    new RegExp(String.raw`\b[Jj]oin\s+${NAME}(?:\s+as\b|\s+and\b|[.,!]|\s+to\b|\s+in\b|\s*\n)`, 'u'),
    new RegExp(String.raw`\b${NAME}\s+is\s+(?:hiring|seeking|looking|recruiting|a\s)`, 'u'),
    new RegExp(String.raw`\b[Aa]t\s+${NAME}\s*,?\s+(?:you|we|our|your)\b`, 'u'),
  ]
  for (const re of patterns) {
    const m = t.match(re)
    const n = m && plausible(m[1])
    if (!n) continue
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const count = (t.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length
    if (count >= 2) return n
  }
  return null
}

module.exports = { companyFromPosting }
