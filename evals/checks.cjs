// Property checks shared by the eval runner and the offline tests. Each returns a list of failure strings ([] = pass).
const { FIXTURES } = require('./fixtures.cjs')

const wordCount = t => String(t || '').trim().split(/\s+/).filter(Boolean).length
const bullets = r => (r?.experience || []).flatMap(e => e?.bullets || [])
const textOf = r => JSON.stringify(r || {}).toLowerCase()

// A rewrite must not claim any skill the posting asks for that the resume does not show.
function checkNoClaimedGaps(fixture, rewritten) {
  const out = []
  const t = textOf(rewritten)
  for (const g of fixture.gaps || []) if (t.includes(g.toLowerCase())) out.push(`claims a gap it does not have: "${g}"`)
  return out
}
function checkSummary(rewritten) {
  const out = []
  if (rewritten?.summary) {
    const n = wordCount(rewritten.summary)
    if (n < 25 || n > 75) out.push(`summary is ${n} words (aim 40-60)`)
  }
  return out
}
function checkBulletLengths(rewritten) {
  return bullets(rewritten).filter(b => wordCount(b) > 28).map(b => `bullet over 28 words: "${b.slice(0, 50)}..."`)
}
function checkLetterShape(text) {
  const out = []
  const n = wordCount(text)
  if (n < 180 || n > 320) out.push(`letter is ${n} words (aim 220-300, ceiling 320)`)
  if (!/^Dear /.test(text)) out.push('no salutation')
  if (/!/.test(text)) out.push('exclamation mark')
  return out
}
function checkScoreSpread(scores, max = 5) {
  if (scores.length < 2) return []
  const spread = Math.max(...scores) - Math.min(...scores)
  return spread > max ? [`score spread ${spread} across ${scores.length} runs (max ${max}): ${scores.join(', ')}`] : []
}

module.exports = { FIXTURES, wordCount, bullets, checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread }
