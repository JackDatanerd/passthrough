// Enforces in code the style rules the rewrite prompt states. A prompt that lists banned phrases only primes the model
// toward them; this finds the ones that slipped through so ONE corrective pass can name them exactly.
//
// Only text the model WROTE is judged: a line that already appears verbatim in the person's own resume is theirs, and
// is never flagged (it would be an unfixable complaint and a pointless retry).

const BAD_OPENERS = /^(?:responsible for|responsibilities (?:included|include)|helped|assisted with|worked on|tasked with|duties (?:included|include|were)|in charge of)\b/i
const BUZZ = /\b(?:team player|hard[- ]?working|self[- ]starter|go[- ]getter|proven track record|synergy|synergies|leverag(?:e|ed|es|ing)|utili[sz](?:e|ed|es|ing)|various|etc\.?|results[- ]driven|detail[- ]oriented|dynamic|passionate)\b/i
const FIRST_PERSON = /\b(?:I|me|my|mine|myself|I'm|I've|I'd)\b/
const MAX_WORDS = 28   // the prompt says 25; the slack is for hyphenations and figures counted as words

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

  const check = (bullets, where) => {
    const verbs = new Map()
    asList(bullets).forEach(b => {
      const t = text(b).trim()
      if (!t || !fresh(t)) return
      if (BAD_OPENERS.test(t)) problems.push(`${where}: a bullet opens with "${t.match(BAD_OPENERS)[0]}" ("${clip(t)}")`)
      const buzz = t.match(BUZZ)
      if (buzz) problems.push(`${where}: a bullet uses the banned word "${buzz[0]}" ("${clip(t)}")`)
      if (FIRST_PERSON.test(t)) problems.push(`${where}: a bullet uses first person ("${clip(t)}")`)
      const words = t.split(/\s+/).length
      if (words > MAX_WORDS) problems.push(`${where}: a bullet is ${words} words, over the 25-word limit ("${clip(t)}")`)
      const verb = t.split(/\s+/)[0].toLowerCase().replace(/[^\p{L}]/gu, '')
      if (verb) verbs.set(verb, (verbs.get(verb) || 0) + 1)
    })
    for (const [v, n] of verbs) if (n > 1) problems.push(`${where}: ${n} bullets in one role open with "${v}" - vary the opening verb`)
  }
  asList(rewritten?.experience).forEach((e, i) => check(e?.bullets, `job ${i + 1}${e?.company ? ` (${text(e.company)})` : ''}`))
  asList(rewritten?.volunteer).forEach((v, i) => check(v?.bullets, `volunteer ${i + 1}`))
  return problems
}

module.exports = { findRewriteStyleProblems }
