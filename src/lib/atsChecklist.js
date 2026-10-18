// Turns the scorer model's checklist into a number, in code.
//
// The model supplies judgements (met / partial / missing) and a verbatim quote for each. Nothing it says is trusted
// blindly:
//   - a requirement whose words are not in the posting is discarded (the model invented it, or a resume told it to);
//   - "met" / "partial" with a quote that is NOT in the resume is downgraded to "missing" (unsupported credit);
//   - the keywords reported as missing are re-checked against both texts, so a person is never told to add a skill the
//     resume already shows or one the posting never asked for.
//   - a "must" whose cue (the posting phrase that makes it a must) is not in the posting is treated as "nice";
//   - length-of-experience rows are COUNTED here from the resume's dates and today's date, never taken on the model's word.
// Every step can only lower a score the model could not justify, never raise one - except the years count, which is
// arithmetic on the resume's own dates rather than a judgement.

const { yearsFromText, tenureClaims } = require('./careerFacts')

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

// Is `quote` really in the resume? Whitespace/punctuation/case-insensitive whole-word match, or (for a longer quote) nearly
// all of its words in order-insensitive presence - models sometimes drop a comma or a bullet glyph.
function quoteInResume(quote, resumeCanon, resumeSet) {
  const q = canon(quote)
  if (!q) return false
  const qt = q.split(' ')
  // A quote has to carry substance: at least one word that is not filler and is two letters or more. Without this a one-letter
  // or filler "quote" (\"a\", \"the\", \"for the\") is trivially inside any resume, and a requirement the resume never mentions
  // was credited as met - exactly the unsupported credit this check exists to remove (Scan/ATS round 12).
  if (!qt.some(w => w.length >= 2 && !STOP.has(w) && !STOP.has(stem(w)))) return false
  // And it has to match whole words: a fragment (\"ython\") is not in a resume that says \"Python\".
  if (` ${resumeCanon} `.includes(` ${q} `)) return true
  const t = qt.map(stem).filter(Boolean)
  if (t.length < 4) return false
  return t.filter(w => resumeSet.has(w)).length / t.length >= 0.9
}


const MUST_MARKER = /\b(?:required|requirements?|must|essential|mandatory|minimum|needs?|needed|core|key|critical|responsible|you will|you'll|will own|will be|own|lead|manage|duties|proficien\w*|expert\w*|at least|\d+\s*\+?\s*years?)\b/i
const GENERIC_YEARS_WORDS = new Set('experience professional relevant industry work related total overall career field similar role roles position positions'.split(' '))

// The cue must be a phrase of the posting AND read like a must-have (or the requirement is stated more than once).
function cueOk(cue, requirement, jdCanon, jdSet) {
  if (typeof cue !== 'string' || !cue.trim()) return false
  if (!quoteInResume(cue, jdCanon, jdSet)) return false
  if (MUST_MARKER.test(cue)) return true
  const key = canon(requirement)
  return key.length > 2 && jdCanon.split(key).length - 1 >= 2
}

// A requirement that is nothing but a length of experience ("3+ years experience"), as opposed to one tied to a skill.
function genericYears(name) {
  const rest = tokens(name).filter(w => !STOP.has(w) && !/^\d+$/.test(w) && !GENERIC_YEARS_WORDS.has(w) && !['in', 'of', 'minimum', 'at', 'least', 'plus'].includes(w))
  return rest.length === 0
}
function requiredYears(r, jdText) {
  const asked = Number.isInteger(r.years) && r.years > 0 && r.years <= 40 ? r.years : (tenureClaims(r.requirement)[0] || null)
  if (!asked || asked > 40) return null
  return tenureClaims(jdText).includes(asked) ? asked : null     // the number must really be in the posting
}

// Pass 1 reply -> the FIXED requirement list every later score of this posting is measured against, or null.
function normalizeRequirements(parsed, jdText) {
  if (!parsed || !Array.isArray(parsed.requirements)) return null
  const jdSet = tokenSet(jdText)
  const seen = new Set(), out = []
  for (const r of parsed.requirements.slice(0, 40)) {
    if (!r || typeof r.requirement !== 'string') continue
    const name = r.requirement.replace(/\s+/g, ' ').trim().slice(0, 80)
    const key = canon(name)
    if (!key || seen.has(key) || !mostlyIn(name, jdSet)) continue
    seen.add(key)
    out.push({
      requirement: name, priority: r.priority === 'must' ? 'must' : 'nice',
      cue: typeof r.cue === 'string' ? r.cue.slice(0, 160) : undefined,
      years: Number.isInteger(r.years) ? r.years : undefined,
    })
    if (out.length >= MAX_REQUIREMENTS) break
  }
  if (out.length < MIN_REQUIREMENTS) return null
  return out.map((r, i) => ({ id: i + 1, ...r }))
}

// Pass 2 reply (results by id, or - older shape - requirement rows by name) laid over the fixed list, in the shape
// computeChecklistScore reads. null when the reply carries no judgement at all.
function mergeJudgement(fixed, judged) {
  const results = Array.isArray(judged?.results) ? judged.results : []
  const named = Array.isArray(judged?.requirements) ? judged.requirements.filter(r => r && typeof r.requirement === 'string') : []
  if (!results.length && !named.length) return null
  const byId = new Map()
  for (const r of results) if (r && Number.isInteger(r.id)) byId.set(r.id, r)
  const rows = fixed.map(f => {
    let j = byId.get(f.id)
    if (!j) {
      const fSet = tokenSet(f.requirement)
      j = named.find(r => canon(r.requirement) === canon(f.requirement)) ||
          named.find(r => mostlyIn(r.requirement, fSet) && mostlyIn(f.requirement, tokenSet(r.requirement)))
    }
    return { requirement: f.requirement, priority: f.priority, cue: f.cue, years: f.years, status: j?.status, evidence: j?.evidence }
  })
  return { requirements: rows, seniority: judged.seniority, title: judged.title }
}

function computeChecklistScore(parsed, { resumeText, jdText, now = new Date() }) {
  if (!parsed || !Array.isArray(parsed.requirements)) return { ok: false, reason: 'NO_CHECKLIST' }
  const resumeCanon = canon(resumeText)
  const resumeSet = tokenSet(resumeText)
  const jdSet = tokenSet(jdText)
  const jdCanon = canon(jdText)
  const candYears = yearsFromText(resumeText, now)
  const seen = new Set()
  const rows = []
  let discarded = 0, downgraded = 0, cueDowngraded = 0
  let genericRequired = null
  for (const r of parsed.requirements.slice(0, 40)) {
    if (!r || typeof r.requirement !== 'string') continue
    const name = r.requirement.replace(/\s+/g, ' ').trim().slice(0, 80)
    const key = canon(name)
    if (!key || seen.has(key)) continue
    if (!mostlyIn(name, jdSet)) { discarded++; continue }          // not the posting's requirement
    seen.add(key)
    let priority = r.priority === 'must' ? 'must' : 'nice'
    // A reply that carries a cue field must back a "must" with a real phrase of the posting; no field at all (an older
    // reply shape) is accepted as before.
    if (priority === 'must' && typeof r.cue === 'string' && !cueOk(r.cue, name, jdCanon, jdSet)) { priority = 'nice'; cueDowngraded++ }
    let status = Object.prototype.hasOwnProperty.call(CREDIT, r.status) ? r.status : 'missing'
    const evidence = typeof r.evidence === 'string' ? r.evidence.trim() : ''
    const askedYears = requiredYears({ ...r, requirement: name }, jdText)
    let computed = false
    if (askedYears) {
      if (genericYears(name)) {
        // Only a length of experience: counted from the dates, not taken on the model's word.
        if (candYears != null) {
          status = candYears >= askedYears ? 'met' : candYears >= askedYears * 0.6 ? 'partial' : 'missing'
          computed = true
          if (genericRequired === null || askedYears > genericRequired) genericRequired = askedYears
        }
      } else if (status === 'met' && candYears != null && candYears < askedYears) {
        status = 'partial'                    // tied to a skill: the whole career is shorter than the years asked
      }
    }
    if (!computed && status !== 'missing') {
      const proven = quoteInResume(evidence, resumeCanon, resumeSet)
      // An empty quote is only believable for "partial" (experience length that no one sentence proves).
      if (!proven && !(status === 'partial' && !evidence)) { status = 'missing'; downgraded++ }
    }
    rows.push({ requirement: name, priority, status, ...(computed ? { computed: true } : {}) })
    if (rows.length >= MAX_REQUIREMENTS) break
  }
  if (rows.length < MIN_REQUIREMENTS) return { ok: false, reason: 'TOO_FEW_REQUIREMENTS', discarded }

  let got = 0, total = 0
  for (const r of rows) { const w = WEIGHT[r.priority]; total += w; got += w * CREDIT[r.status] }
  const coverage = got / total
  // Clearly under the years the posting asks for: the model's "match" is overruled (never the other way round).
  let seniority = parsed.seniority
  if (genericRequired !== null && candYears != null && candYears < genericRequired * 0.6 && (seniority === 'match' || !SENIORITY[seniority])) seniority = 'under'
  const sen = SENIORITY[seniority] ?? SENIORITY.match
  const tit = TITLE[parsed.title] ?? TITLE.partial
  const score = Math.max(0, Math.min(100, Math.round(100 * (SHARE.coverage * coverage + SHARE.seniority * sen + SHARE.title * tit))))

  const missingKeywords = rows
    .filter(r => r.status === 'missing' && !allTokensIn(r.requirement, resumeSet))   // never ask for what the resume has
    .sort((a, b) => WEIGHT[b.priority] - WEIGHT[a.priority])
    .map(r => r.requirement)
    .filter(k => k.length <= 60)
    .slice(0, 15)

  // The requirements the posting calls ESSENTIAL that the resume does not show, nothing else. Only these may ever be named in
  // a cover letter: a missing nice-to-have is not a reason to tell an employer what the candidate lacks.
  const missingMust = rows
    .filter(r => r.status === 'missing' && r.priority === 'must' && !allTokensIn(r.requirement, resumeSet))
    .map(r => r.requirement)
    .filter(k => k.length <= 60)
    .slice(0, 3)

  // The essential requirements the resume clearly shows (stated, not downgraded): what a cover letter should build on.
  const metMust = rows.filter(r => r.status === 'met' && r.priority === 'must').map(r => r.requirement).filter(k => k.length <= 60).slice(0, 3)

  return { ok: true, score, coverage, missingKeywords, missingMust, metMust, rows, discarded, downgraded, cueDowngraded, years: candYears }
}

module.exports = { computeChecklistScore, normalizeRequirements, mergeJudgement, quoteInResume, canon, tokenSet, mostlyIn, cueOk, genericYears, WEIGHT, CREDIT, SHARE, MIN_REQUIREMENTS }
