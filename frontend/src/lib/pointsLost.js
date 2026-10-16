// Where a scan's missing points are. The server sends how much each category counts (scan.atsDetail.weights, taken from
// the scoring service itself); this splits the points between the score and 100 across the categories in proportion to
// weight x shortfall, so the numbers always add up to the real gap whatever the AI blend did to the final score.
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
export function computePointsLost(scan) {
  const weights = scan?.atsDetail?.weights
  if (!weights || !num(scan.atsScore)) return null
  const gap = Math.round(100 - scan.atsScore)
  if (gap <= 0) return { gap: 0, items: [] }
  const rows = CATS.map(c => ({ ...c, loss: num(scan[c.score]) && num(weights[c.key]) && weights[c.key] > 0 ? weights[c.key] * (100 - pct(scan[c.score])) : 0 }))
  const total = rows.reduce((a, r) => a + r.loss, 0)
  if (total <= 0) return null
  // largest-remainder rounding, so the points shown add up to the gap exactly
  const raw = rows.map(r => (r.loss / total) * gap)
  const pts = raw.map(Math.floor)
  let left = gap - pts.reduce((a, b) => a + b, 0)
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0 && rows[i].loss > 0) { pts[i]++; left-- } })
  const items = rows.map((r, i) => ({ key: r.key, label: r.label, points: pts[i], reason: reasonFor(r.key, scan.atsDetail) }))
    .filter(i => i.points > 0).sort((a, b) => b.points - a.points)
  return { gap, items }
}
