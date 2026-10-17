// Property checks shared by the eval runner and the offline tests. Each returns a list of failure strings ([] = pass).
// Limits come from src/prompts/constants.js - the SAME numbers the prompts state and the guards enforce.
const { FIXTURES, REQUIRED_KINDS } = require('./fixtures.cjs')
const { LETTER_WORDS, BULLET_WORDS, SUMMARY_WORDS } = require('../src/prompts/constants')
const { isAllowedRename, squash } = require('../src/lib/skillAliases')

const wordCount = t => String(t || '').trim().split(/\s+/).filter(Boolean).length
const bullets = r => (r?.experience || []).flatMap(e => e?.bullets || [])
const textOf = r => JSON.stringify(r || {}).toLowerCase()
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A rewrite must not claim any skill the posting asks for that the resume does not show. Whole-word match, so a gap of
// "Go" is not triggered by "Google", nor "R" by "Reporting".
function checkNoClaimedGaps(fixture, rewritten) {
  const out = []
  const t = textOf(rewritten)
  for (const g of fixture.gaps || []) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(g.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u')
    if (re.test(t)) out.push(`claims a gap it does not have: "${g}"`)
  }
  return out
}
function checkSummary(rewritten) {
  const out = []
  if (rewritten?.summary) {
    const n = wordCount(rewritten.summary)
    if (n < SUMMARY_WORDS.guardMin || n > SUMMARY_WORDS.guardMax) out.push(`summary is ${n} words (aim ${SUMMARY_WORDS.min}-${SUMMARY_WORDS.max})`)
  }
  return out
}
function checkBulletLengths(rewritten) {
  return bullets(rewritten).filter(b => wordCount(b) > BULLET_WORDS.guard).map(b => `bullet over ${BULLET_WORDS.guard} words: "${b.slice(0, 50)}..."`)
}

// The letter's length counts the salutation and sign-off too (about 8 words), hence min..ceiling on the whole text.
function checkLetterShape(text, { uk = null } = {}) {
  const out = []
  const n = wordCount(text)
  if (n < LETTER_WORDS.min || n > LETTER_WORDS.ceiling) out.push(`letter is ${n} words (aim ${LETTER_WORDS.min}-${LETTER_WORDS.max}, ceiling ${LETTER_WORDS.ceiling})`)
  if (!/^Dear /.test(text)) out.push('no salutation')
  if (/!/.test(text)) out.push('exclamation mark')
  if (uk === true && !/\n\n(?:Yours sincerely|Yours faithfully),\n/.test(text)) out.push('UK letter does not close with "Yours sincerely" / "Yours faithfully"')
  if (uk === false && !/\n\nSincerely,\n/.test(text)) out.push('US letter does not close with "Sincerely"')
  return out
}
// The credential line is hard, so the AI half of the score is held to a tight spread (it is 30% of the final number).
function checkScoreSpread(scores, max = 2) {
  if (scores.length < 2) return []
  const spread = Math.max(...scores) - Math.min(...scores)
  return spread > max ? [`score spread ${spread} across ${scores.length} runs (max ${max}): ${scores.join(', ')}`] : []
}
// Blended scores of one resume across runs must not straddle the pass line or the credential line.
function checkFlips(blendedScores, thresholds = [75, 80]) {
  const out = []
  for (const t of thresholds) if (blendedScores.some(s => s >= t) && blendedScores.some(s => s < t)) out.push(`the verdict flips across runs at the ${t} line: ${blendedScores.join(', ')}`)
  return out
}
// Two requirement lists for the same posting, compared by name: |A and B| / |A or B|.
function listAgreement(a, b) {
  const k = l => new Set((l || []).map(x => squash(typeof x === 'string' ? x : x.requirement)).filter(Boolean))
  const A = k(a), B = k(b)
  if (!A.size && !B.size) return 1
  let inter = 0; for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

// ── spelling: US postings get US spelling, UK postings UK. Words the person (or the posting) already used are exempt. ──
const UK_RE = /^(?:organis\w*|colour\w*|programme\w*|analys(?:e|ed|es|ing)|centre\w*|behaviour\w*|favour\w*|honour\w*|labour\w*|catalogue\w*|recognis\w*|prioritis\w*|optimis\w*|utilis\w*|specialis\w*|minimis\w*|maximis\w*|summaris\w*|realis\w*|modelling|travelling)$/
const US_RE = /^(?:organiz\w*|color\w*|analyz\w*|center\w*|behavior\w*|favor\w*|honor\w*|labor\w*|catalog|recogniz\w*|prioritiz\w*|optimiz\w*|utiliz\w*|specializ\w*|minimiz\w*|maximiz\w*|summariz\w*|realiz\w*|modeling|traveling)$/
function checkSpelling(fixture, outputText, inputText = '') {
  const wordsOf = t => (String(t || '').toLowerCase().match(/\p{L}+/gu) || [])
  const exempt = new Set([...wordsOf(inputText), ...wordsOf(fixture.jd)])
  const re = fixture.locale === 'UK' ? US_RE : UK_RE
  const found = [...new Set(wordsOf(outputText).filter(w => re.test(w) && !exempt.has(w)))]
  return found.slice(0, 5).map(w => `${fixture.locale === 'UK' ? 'US' : 'UK'} spelling "${w}" in a ${fixture.locale} resume`)
}

// ── level: a person who only ever assisted must not come back as someone who led ───────────────────────────────────
const SUPPORT_OPEN = /^(?:assist(?:ed|ing)?|help(?:ed|ing)?|support(?:ed|ing)?|contribut(?:ed|ing)?|participat(?:ed|ing)?|shadow(?:ed|ing)?|aid(?:ed|ing)?)\b/i
const LEAD_OPEN = /^(?:led|lead|managed|directed|owned|ran|headed|spearheaded|oversaw|supervised|orchestrated|championed|drove)\b/i
const LEAD_ANY = /\b(?:led|lead|managed|directed|owned|oversaw|supervised|headed|ran the)\b/i
function checkLevelPreserved(original, rewritten) {
  const out = []
  ;(original?.experience || []).forEach((j, i) => {
    const bs = j?.bullets || []
    if (!bs.some(b => SUPPORT_OPEN.test(b)) || bs.some(b => LEAD_ANY.test(b))) return
    for (const b of rewritten?.experience?.[i]?.bullets || []) if (LEAD_OPEN.test(String(b).trim())) out.push(`job ${i + 1}: "${String(b).slice(0, 50)}" opens with a leadership verb but the input shows support-level work only`)
  })
  return out
}
function checkNoExtraBullets(original, rewritten) {
  const out = []
  ;(rewritten?.experience || []).forEach((j, i) => {
    const had = (original?.experience?.[i]?.bullets || []).length
    const has = (j?.bullets || []).length
    if (had && has > had) out.push(`job ${i + 1} has ${has} bullets, the input had ${had}`)
  })
  return out
}
// Every skill in the output is in the input (or its text), or an allowed rename of one.
function checkSkills(original, rewritten) {
  const out = []
  const orig = original?.skills || []
  const keys = new Set(orig.map(squash))
  const hay = JSON.stringify(original || {}).toLowerCase()
  for (const s of rewritten?.skills || []) {
    if (keys.has(squash(s))) continue
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(String(s).toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(hay)) continue
    if (orig.some(o => isAllowedRename(o, s, hay))) continue
    out.push(`skill "${s}" is not in the resume and is not an allowed rename`)
  }
  return out
}

// ── letters ───────────────────────────────────────────────────────────────────────────────────────────────────────
function checkHonorific(text, application = {}) {
  const first = String(text || '').split('\n')[0]
  const m = first.match(/\b(?:Mr|Mrs|Ms|Miss|Mx|Dr)\b\.?/)
  return m && !String(application.recipient || '').includes(m[0].replace('.', '')) ? [`guessed an honorific "${m[0]}" in the salutation`] : []
}
// A letter may NAME a real gap honestly ("I have not worked in X") - never claim it, and name at most one. Every sentence that
// mentions a gap term must carry a negation; more than one distinct gap named is a fail.
const NEGATION = /\b(?:not|no|never|yet|without|lack|lacks|haven't|hasn't|don't|doesn't|did not|have not|do not|am new to|new to|limited|learning|learn)\b/i
function checkLetterGaps(fixture, text) {
  const out = []
  const sentences = String(text || '').split(/(?<=[.!?])\s+|\n+/)
  const named = new Set()
  for (const g of fixture.gaps || []) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(g.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u')
    for (const sent of sentences) if (re.test(sent.toLowerCase())) { named.add(g); if (!NEGATION.test(sent)) out.push(`the letter may claim "${g}": "${sent.slice(0, 70)}"`) }
  }
  if (named.size > 1) out.push(`the letter names ${named.size} gaps (${[...named].join(', ')}); at most one`)
  return out
}
// Share of letters whose first five words are shared with another letter. One model letter used to teach every user the same opening.
function openingDuplication(letters) {
  const key = t => String(t || '').split('\n').filter(l => l.trim() && !/^Dear /.test(l)).slice(0, 1).join(' ').toLowerCase().replace(/[^\p{L}\s]/gu, '').split(/\s+/).slice(0, 5).join(' ')
  const keys = letters.map(key)
  const counts = new Map(); keys.forEach(k => counts.set(k, (counts.get(k) || 0) + 1))
  return letters.length ? keys.filter(k => counts.get(k) > 1).length / letters.length : 0
}

// ── extraction against hand-labelled gold ──────────────────────────────────────────────────────────────────────────
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
function goldScore(expected, actual, raw) {
  const sets = r => ({
    company: new Set((r?.experience || []).map(e => norm(e.company)).filter(Boolean)),
    title: new Set((r?.experience || []).map(e => norm(e.title)).filter(Boolean)),
    skill: new Set((r?.skills || []).map(norm).filter(Boolean)),
    school: new Set((r?.education || []).map(e => norm(e.institution)).filter(Boolean)),
    cert: new Set((r?.certifications || []).map(norm).filter(Boolean)),
  })
  const E = sets(expected), A = sets(actual)
  let tp = 0, fp = 0, fn = 0
  const missing = [], extra = []
  for (const f of Object.keys(E)) {
    for (const x of E[f]) { if (A[f].has(x)) tp++; else { fn++; missing.push(`${f}: ${x}`) } }
    for (const x of A[f]) if (!E[f].has(x)) { fp++; extra.push(`${f}: ${x}`) }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  const rawN = norm(raw)
  const hallucinated = []
  for (const f of Object.keys(A)) for (const x of A[f]) if (x && !rawN.includes(x)) hallucinated.push(`${f}: ${x}`)
  const got = bullets(actual).map(norm).filter(Boolean)
  const verbatimRate = got.length ? got.filter(b => rawN.includes(b)).length / got.length : 1
  return { f1, precision, recall, hallucinated, verbatimRate, missing, extra }
}

module.exports = {
  FIXTURES, REQUIRED_KINDS, wordCount, bullets,
  checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread, checkFlips, listAgreement,
  checkSpelling, checkLevelPreserved, checkNoExtraBullets, checkSkills, checkHonorific, checkLetterGaps, openingDuplication, goldScore,
}
