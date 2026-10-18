// How the document reads to a PERSON, as one number, from the structured resume alone (no model call, deterministic).
//
// The fix loop used to pick its winner on the ATS score only, so a rewrite that read worse but scored a point higher won,
// and a better-reading one that scored a point lower lost. Inside a small band of ATS points the winner is now the document
// that reads better; outside the band the ATS score still decides, and a candidate is never chosen if that would take a
// document that clears the credential line under it (see pickWinner).
//
// What it rewards and penalises is what the rewrite prompt asks for and a recruiter's seven-second scan notices: a summary,
// outcome-led bullets with a figure, varied openers, bullets short enough to read, no filler, and skills that are SHOWN in
// the work rather than only listed.

const { FIRST_PERSON } = require('./firstPerson')
const { BUZZ_WORDS, BAD_OPENER_PHRASES, wordsRegex, BULLET_WORDS } = require('../prompts/constants')

const listOf = v => (Array.isArray(v) ? v : [])
const str = v => (typeof v === 'string' ? v.trim() : '')
const BUZZ = wordsRegex(BUZZ_WORDS)
const BAD_OPEN = new RegExp(`^(?:${BAD_OPENER_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')

function bulletsOf(r) {
  const out = []
  for (const e of listOf(r?.experience)) for (const b of listOf(e?.bullets)) if (str(b)) out.push(str(b))
  return out
}

function readerQuality(resume) {
  const bullets = bulletsOf(resume)
  const n = bullets.length
  let score = 70
  if (str(resume?.summary)) score += 6
  if (n) {
    const share = fn => bullets.filter(fn).length / n
    score += 12 * share(b => /\d/.test(b))                                              // a figure the reader can weigh
    score -= 14 * share(b => BAD_OPEN.test(b))                                           // "Responsible for", "Helped"
    score -= 10 * share(b => BUZZ.test(b))                                               // filler a reader skips
    score -= 10 * share(b => FIRST_PERSON.test(b))
    score -= 10 * share(b => b.split(/\s+/).length > BULLET_WORDS.guard + 7)             // run-ons
    score -= 6 * share(b => b.split(/\s+/).length < 5)                                   // fragments
    const openers = {}
    for (const b of bullets) { const w = (b.toLowerCase().match(/^[a-z]+/) || [''])[0]; if (w) openers[w] = (openers[w] || 0) + 1 }
    const repeats = Object.values(openers).filter(c => c >= 3).reduce((a, c) => a + (c - 2), 0)
    score -= Math.min(10, repeats * 2.5)                                                 // the same verb again and again
  }
  const skills = listOf(resume?.skills).map(str).filter(Boolean)
  if (skills.length) {
    const work = (bullets.join(' ') + ' ' + listOf(resume?.projects).map(p => `${str(p?.description)} ${listOf(p?.technologies).join(' ')}`).join(' ')).toLowerCase()
    const shown = skills.filter(s => work.includes(s.toLowerCase())).length / skills.length
    score += 6 * shown                                                                   // skills shown in the work, not only listed
    if (skills.length > 28) score -= Math.min(8, (skills.length - 28) * 0.8)             // a wall of keywords
  }
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10))
}

// ATS points inside which the better-reading document wins.
const SCORE_BAND = 2

// Does `cand` replace `best`? scores are the blended ATS scores; `threshold` is the credential line.
function pickWinner({ candScore, bestScore, candData, bestData, baselineHeld = false, threshold = null }) {
  if (typeof threshold === 'number') {
    if (bestScore >= threshold && candScore < threshold) return false     // never trade the credential for style
    if (candScore >= threshold && bestScore < threshold) return true
  }
  if (candScore > bestScore + SCORE_BAND) return true
  if (candScore < bestScore - SCORE_BAND) return false
  const rc = readerQuality(candData), rb = readerQuality(bestData)
  if (Math.abs(rc - rb) >= 1) return rc > rb
  return candScore > bestScore || (baselineHeld && candScore === bestScore)
}

module.exports = { readerQuality, pickWinner, SCORE_BAND }
