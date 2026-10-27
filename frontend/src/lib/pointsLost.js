// Where a scan's missing points are. The server sends how much each category counts (scan.atsDetail.weights, taken from
// the scoring service itself); this splits the points between the score and 100 across the categories in proportion to
// weight x shortfall, so the numbers always add up to the real gap whatever the AI blend did to the final score.
import { ATS_RULE_WEIGHT } from './scoreThresholds'
const CATS = [
  { key: 'keywords', score: 'keywordScore',  label: 'Keyword match' },
  { key: 'format',   score: 'formatScore',   label: 'Formatting' },
  { key: 'sections', score: 'sectionsScore', label: 'Sections' },
  { key: 'content',  score: 'contentScore',  label: 'Content' },
]
const num = n => typeof n === 'number' && Number.isFinite(n)
const pct = n => Math.max(0, Math.min(100, n))

export function reasonFor(key, detail) {
  if (!detail) return null
  if (key === 'keywords') {
    const missing = detail.keywords?.missing || []
    if (missing.length) return `Missing from your resume: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}`
    const w = detail.keywords?.warnings?.[0]
    return w ? w.charAt(0).toUpperCase() + w.slice(1) : null
  }
  if (key === 'format') {
    const issues = detail.format?.issues || []
    return issues.length ? `${issues[0]}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}` : null
  }
  if (key === 'sections') {
    const missing = detail.sections?.missing || []
    return missing.length ? `Missing: ${missing.join(', ')}` : null
  }
  const u = detail.content?.unquantified
  if (u && u.count > 0) return `${u.count} of ${u.total} bullet${u.total === 1 ? '' : 's'} give no number`
  const r = detail.content?.actionVerbRate
  return num(r) && r < 0.7 ? `Only ${Math.round(r * 100)}% of bullets open with an action verb` : null
}

// -> { gap, items: [{ key, label, points, reason }] } sorted biggest first, or null when it cannot be said honestly.
const aiReason = detail => {
  const missing = detail?.aiMissingKeywords || []
  return missing.length
    ? `Our AI review found weaker evidence for: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}`
    : "Our AI review judged the match to this posting weaker than your resume's checks alone"
}
export function computePointsLost(scan) {
  const weights = scan?.atsDetail?.weights
  if (!weights || !num(scan.atsScore)) return null
  const gap = Math.round(100 - scan.atsScore)
  if (gap <= 0) return { gap: 0, items: [] }
  const rows = CATS.map(c => ({ ...c, loss: num(scan[c.score]) && num(weights[c.key]) && weights[c.key] > 0 ? weights[c.key] * (100 - pct(scan[c.score])) : 0 }))
  const total = rows.reduce((a, r) => a + r.loss, 0)
  // The score is 70% the four rule categories and 30% the AI review of fit to the posting, so a gap is not all the rules' doing:
  // a resume can score 100 on every category and still land at 88 because the AI found weaker evidence for the job's requirements.
  // Give the rules only their own share of the gap and show the rest as the AI review's, instead of loading it onto a category
  // that scored full marks (or showing nothing at all when every category is perfect).
  const weightSum = rows.reduce((a, r) => a + (num(scan[r.score]) && num(weights[r.key]) && weights[r.key] > 0 ? weights[r.key] : 0), 0)
  const ruleLoss100 = weightSum > 0 ? total / weightSum : 0
  const ruleWeight = ATS_RULE_WEIGHT
  const ruleGap = scan.scoredWithoutAi ? gap : Math.min(gap, ruleWeight * ruleLoss100)
  // A score the AI never touched has no AI share: whatever the rules do not explain is rounding, so it stays with them.
  const aiGap = scan.scoredWithoutAi ? 0 : gap - ruleGap
  if (total <= 0 && aiGap < 0.5) return null
  const shares = [...rows.map(r => (total > 0 ? (r.loss / total) * ruleGap : 0)), aiGap]
  // largest-remainder rounding, so the points shown add up to the gap exactly
  const pts = shares.map(Math.floor)
  let left = gap - pts.reduce((a, b) => a + b, 0)
  shares.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0 && shares[i] > 0) { pts[i]++; left-- } })
  const items = rows.map((r, i) => ({ key: r.key, label: r.label, points: pts[i], reason: reasonFor(r.key, scan.atsDetail) }))
  items.push({ key: 'ai', label: 'Fit to this job', points: pts[rows.length], reason: aiReason(scan.atsDetail) })
  return { gap, items: items.filter(i => i.points > 0).sort((a, b) => b.points - a.points) }
}
