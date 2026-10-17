// Enforces in code the rules the rewrite prompt states. A prompt that lists banned phrases only primes the model
// toward them; this finds the ones that slipped through so ONE corrective pass can name them exactly.
//
// Only text the model WROTE is judged: a line that already appears verbatim in the person's own resume is theirs, and
// is never flagged (it would be an unfixable complaint and a pointless retry).
//
// Three families of problem, all fed to the same single corrective pass:
//   style       - banned openers / buzzwords / first person / length / a verb used too often
//   provenance  - a figure in a bullet the model wrote that is not in the input bullets it says it was built from
//   renames     - a skill renamed to something that is not the same thing (a different version, a related tool)

const { BUZZ_WORDS, BAD_OPENER_PHRASES, wordsRegex, BULLET_WORDS, VERB_CAP_WHOLE_RESUME } = require('../prompts/constants')
const { isAllowedRename } = require('./skillAliases')

const BAD_OPENERS = new RegExp(`^(?:${BAD_OPENER_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
const BUZZ = wordsRegex(BUZZ_WORDS)
const { FIRST_PERSON } = require('./firstPerson')           // shared with the ATS craft feedback; "Phase I" / "Type I" are not first person
const MAX_WORDS = BULLET_WORDS.guard   // the prompt says 25; the slack is for hyphenations and figures counted as words

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const asList = v => (Array.isArray(v) ? v : [])
const text = v => (typeof v === 'string' ? v : '')

function ownText(resume) {
  const set = new Set()
  const add = t => { const n = norm(t); if (n) set.add(n) }
  add(resume?.summary)
  for (const e of asList(resume?.experience)) asList(e?.bullets).forEach(add)
  for (const v of asList(resume?.volunteer)) asList(v?.bullets).forEach(add)
  for (const p of asList(resume?.projects)) add(p?.description)
  return set
}

function findRewriteStyleProblems(original, rewritten) {
  const mine = ownText(original)
  const problems = []
  const fresh = t => { const n = norm(t); return n && !mine.has(n) }
  const clip = t => (t.length > 70 ? t.slice(0, 67) + '...' : t)

  const summary = text(rewritten?.summary)
  if (summary && fresh(summary)) {
    if (FIRST_PERSON.test(summary)) problems.push(`the summary uses first person ("${clip(summary)}")`)
    const m = summary.match(BUZZ) || summary.match(/\b(?:seeking|motivated)\b/i)
    if (m) problems.push(`the summary uses the banned word "${m[0]}"`)
  }

  const wholeResume = new Map()
  const check = (bullets, where, countWhole) => {
    const verbs = new Map()
    asList(bullets).forEach(b => {
      const t = text(b).trim()
      if (!t || !fresh(t)) return
      if (BAD_OPENERS.test(t)) problems.push(`${where}: a bullet opens with "${t.match(BAD_OPENERS)[0]}" ("${clip(t)}")`)
      const buzz = t.match(BUZZ)
      if (buzz) problems.push(`${where}: a bullet uses the banned word "${buzz[0]}" ("${clip(t)}")`)
      if (FIRST_PERSON.test(t)) problems.push(`${where}: a bullet uses first person ("${clip(t)}")`)
      const words = t.split(/\s+/).length
      if (words > MAX_WORDS) problems.push(`${where}: a bullet is ${words} words, over the ${BULLET_WORDS.prompt}-word limit ("${clip(t)}")`)
      const verb = t.split(/\s+/)[0].toLowerCase().replace(/[^\p{L}]/gu, '')
      if (verb) {
        verbs.set(verb, (verbs.get(verb) || 0) + 1)
        if (countWhole) wholeResume.set(verb, (wholeResume.get(verb) || 0) + 1)
      }
    })
    for (const [v, n] of verbs) if (n > 1) problems.push(`${where}: ${n} bullets in one role open with "${v}" - vary the opening verb`)
  }
  asList(rewritten?.experience).forEach((e, i) => check(e?.bullets, `job ${i + 1}${e?.company ? ` (${text(e.company)})` : ''}`, true))
  asList(rewritten?.volunteer).forEach((v, i) => check(v?.bullets, `volunteer ${i + 1}`, false))
  for (const [v, n] of wholeResume) if (n > VERB_CAP_WHOLE_RESUME) problems.push(`the resume: ${n} bullets across all roles open with "${v}" - use each opening verb at most ${VERB_CAP_WHOLE_RESUME} times`)
  return problems
}

// ── provenance ──────────────────────────────────────────────────────────────────────────────────────────────────
const figuresIn = s => new Set((String(s || '').match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => x.replace(/,/g, '')))

// `input` is the resume the model was GIVEN (the indices in `provenance[].from` index its bullets); `rewritten` is what
// it returned. A figure in a bullet the model wrote must be in the input bullets it says it was built from. An entry
// that points at nothing valid is skipped (no claim, no check) - the global invented-number guard still applies.
function findProvenanceProblems(input, rewritten, provenance) {
  const problems = []
  if (!Array.isArray(provenance)) return problems
  const inJobs = asList(input?.experience), outJobs = asList(rewritten?.experience)
  const seen = new Set()
  for (const p of provenance.slice(0, 80)) {
    if (!p || !Number.isInteger(p.job) || !Number.isInteger(p.bullet) || !Array.isArray(p.from)) continue
    const out = outJobs[p.job], src = inJobs[p.job]
    const bullet = out && asList(out.bullets)[p.bullet]
    if (typeof bullet !== 'string' || !src) continue
    const sources = p.from.filter(Number.isInteger).map(i => asList(src.bullets)[i]).filter(t => typeof t === 'string')
    if (!sources.length) continue
    const allowed = figuresIn(sources.join(' '))
    const stray = [...figuresIn(bullet)].filter(n => !allowed.has(n))
    const key = `${p.job}:${p.bullet}`
    if (stray.length && !seen.has(key)) {
      seen.add(key)
      problems.push(`job ${p.job + 1} bullet ${p.bullet + 1} uses the figure ${stray.slice(0, 3).join(', ')} that is not in the input bullets it was built from ("${bullet.length > 70 ? bullet.slice(0, 67) + '...' : bullet}") - remove it`)
    }
  }
  return problems
}

// ── renames ─────────────────────────────────────────────────────────────────────────────────────────────────────
function resumeWords(resume) {
  const out = []
  const walk = v => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }
  walk(resume)
  return out.join('\n')
}
function findRenameProblems(input, skillRenames) {
  const problems = []
  if (!Array.isArray(skillRenames)) return problems
  const hay = resumeWords(input)
  for (const r of skillRenames.slice(0, 40)) {
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') continue
    if (!isAllowedRename(r.from, r.to, hay)) problems.push(`the skill "${r.from}" was renamed "${r.to}", which is not the same thing (a different version or a related tool) - keep "${r.from}"`)
  }
  return problems
}

module.exports = { findRewriteStyleProblems, findProvenanceProblems, findRenameProblems }
