// The AI half of the score is 30% of the final number (ATS_AI_WEIGHT), so its wobble moves the result by a third as much -
// but a resume whose BLENDED score lands within a point of the pass line or the credential line can still be decided by it.
// Only those get extra samples (two more, median taken); everything else costs the one call it always did.

const BORDERLINE_POINTS = 1

function blended(ruleScore, aiScore, c, maxAbove = 25) {
  const ai = Math.min(Math.max(aiScore, 0), 100, ruleScore + maxAbove)
  return Math.round(ruleScore * c.ATS_RULE_WEIGHT + ai * c.ATS_AI_WEIGHT)
}

function isBorderline(ruleScore, aiScore, c, maxAbove = 25) {
  if (typeof ruleScore !== 'number' || !Number.isFinite(ruleScore) || typeof aiScore !== 'number' || !Number.isFinite(aiScore)) return false
  const b = blended(ruleScore, aiScore, c, maxAbove)
  return [c.ATS_PASS_THRESHOLD, c.ATS_BADGE_THRESHOLD].some(t => Math.abs(b - t) <= BORDERLINE_POINTS)
}

// samples: [{ result, ai }]. With three, the middle one by ai score (its whole result is returned, so the checklist that
// produced the median travels with it); with fewer than three, the first.
function pickMedian(samples) {
  if (!Array.isArray(samples) || !samples.length) return null
  if (samples.length < 3) return samples[0]
  return [...samples].sort((a, b) => a.ai - b.ai)[1]
}

module.exports = { isBorderline, pickMedian, blended, BORDERLINE_POINTS }
