// Turns the scorer model's checklist into a number, in code.
//
// The model supplies judgements (met / partial / missing) and a verbatim quote for each. Nothing it says is trusted
// blindly:
//   - a requirement whose words are not in the posting is discarded (the model invented it, or a resume told it to);
//   - "met" / "partial" with a quote that is NOT in the resume is downgraded to "missing" (unsupported credit);
//   - the keywords reported as missing are re-checked against both texts, so a person is never told to add a skill the
//     resume already shows or one the posting never asked for.
// Every step can only lower a score the model could not justify, never raise one.

const WEIGHT = { must: 3, nice: 1 }
const CREDIT = { met: 1, partial: 0.5, missing: 0 }
const SENIORITY = { match: 1, over: 0.75, under: 0.35 }
const TITLE = { strong: 1, partial: 0.55, weak: 0.15 }
// Share of the score from requirement coverage; the rest is level and title fit.
const SHARE = { coverage: 0.80, seniority: 0.12, title: 0.08 }
const MIN_REQUIREMENTS = 3
const MAX_REQUIREMENTS = 20

const STOP = new Set('a an and are as at be by for from in into of on or the to with using use used experience knowledge skills skill ability strong working work proven demonstrated years year plus'.split(' '))

function canon(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/c\+\+/g, 'cpp').replace(/c#/g, 'csharp').replace(/f#/g, 'fsharp').replace(/\.net\b/g, 'dotnet')
    .replace(/node\.js/g, 'nodejs').replace(/\bvue\.js\b/g, 'vuejs').replace(/\bnext\.js\b/g, 'nextjs')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
// Light stemming so "dashboards" matches "dashboard" and "managing" matches "manage".
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1)
  return w
}
const tokens = s => canon(s).split(' ').filter(Boolean).map(stem)
const tokenSet = s => new Set(tokens(s))

// Every significant word of `phrase` appears in `text` (a skill like "Tableau dashboards" counts as present only when
// both words do).
function allTokensIn(phrase, textSet) {
  const t = tokens(phrase).filter(w => !STOP.has(w))
  return t.length > 0 && t.every(w => textSet.has(w))
}
// At least half of the significant words appear - enough to say the requirement is the posting's, not invented.
function mostlyIn(phrase, textSet) {
  const t = tokens(phrase).filter(w => !STOP.has(w))
  if (!t.length) return false
  const hit = t.filter(w => textSet.has(w)).length
  return hit / t.length >= 0.5
}

// Is `quote` really in the resume? Whitespace/punctuation/case-insensitive substring, or (for a longer quote) nearly
// all of its words in order-insensitive presence - models sometimes drop a comma or a bullet glyph.
function quoteInResume(quote, resumeCanon, resumeSet) {
  const q = canon(quote)
  if (!q) return false
  if (resumeCanon.includes(q)) return true
  const t = q.split(' ').map(stem).filter(Boolean)
  if (t.length < 4) return false
  return t.filter(w => resumeSet.has(w)).length / t.length >= 0.9
}

function computeChecklistScore(parsed, { resumeText, jdText }) {
  if (!parsed || !Array.isArray(parsed.requirements)) return { ok: false, reason: 'NO_CHECKLIST' }
  const resumeCanon = canon(resumeText)
  const resumeSet = tokenSet(resumeText)
  const jdSet = tokenSet(jdText)
  const seen = new Set()
  const rows = []
  let discarded = 0, downgraded = 0
  for (const r of parsed.requirements.slice(0, 40)) {
    if (!r || typeof r.requirement !== 'string') continue
    const name = r.requirement.replace(/\s+/g, ' ').trim().slice(0, 80)
    const key = canon(name)
    if (!key || seen.has(key)) continue
    if (!mostlyIn(name, jdSet)) { discarded++; continue }          // not the posting's requirement
    seen.add(key)
    const priority = r.priority === 'must' ? 'must' : 'nice'
    let status = Object.prototype.hasOwnProperty.call(CREDIT, r.status) ? r.status : 'missing'
    const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : ''
    if (status !== 'missing') {
      const proven = quoteInResume(evidence, resumeCanon, resumeSet)
      // An empty quote is only believable for "partial" (experience length that no one sentence proves).
      if (!proven && !(status === 'partial' && !evidence)) { status = 'missing'; downgraded++ }
    }
    rows.push({ requirement: name, priority, status })
    if (rows.length >= MAX_REQUIREMENTS) break
  }
  if (rows.length < MIN_REQUIREMENTS) return { ok: false, reason: 'TOO_FEW_REQUIREMENTS', discarded }

  let got = 0, total = 0
  for (const r of rows) { const w = WEIGHT[r.priority]; total += w; got += w * CREDIT[r.status] }
  const coverage = got / total
  const sen = SENIORITY[parsed.seniority] ?? SENIORITY.match
  const tit = TITLE[parsed.title] ?? TITLE.partial
  const score = Math.max(0, Math.min(100, Math.round(100 * (SHARE.coverage * coverage + SHARE.seniority * sen + SHARE.title * tit))))

  const missingKeywords = rows
    .filter(r => r.status === 'missing' && !allTokensIn(r.requirement, resumeSet))   // never ask for what the resume has
    .sort((a, b) => WEIGHT[b.priority] - WEIGHT[a.priority])
    .map(r => r.requirement)
    .filter(k => k.length <= 60)
    .slice(0, 15)

  return { ok: true, score, coverage, missingKeywords, rows, discarded, downgraded }
}

module.exports = { computeChecklistScore, quoteInResume, canon, WEIGHT, CREDIT, SHARE, MIN_REQUIREMENTS }
