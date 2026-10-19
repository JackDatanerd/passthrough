// The homepage's "Hot categories" ranking, re-derived in JavaScript from raw interview reports.
//
// The PUBLIC page never uses this: GET /api/stats asks the database (public_hot_categories(), migration 0070).
// This module exists so the admin screen can show the counts behind that ranking, and answer "what would the page
// show if the threshold were N, or if this field had M more reports?" without touching the public data. The rules
// below therefore mirror the SQL function line for line — keep the two in step:
//
//   * only outcome = 'INTERVIEW' rows with a role_category count (a report with no field is invisible to the ranking);
//   * a report is in the CURRENT window when answered_at >= now - days, in the PREVIOUS one when it is older than that
//     but not older than now - 2 * days;
//   * a field is listed only when its current count is >= max(minReports, 1);
//   * ordered by current count (high to low) then category name, and at most 12 fields are returned;
//   * the arrow is changePct(current, previous), which is null when the previous period is too small to quote.
const { changePct } = require('./outcomes')

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_LISTED = 12   // public_hot_categories(): `limit 12`

// rows: [{ role_category, answered_at }]. Returns, per window, { fields: { [category]: { current, previous } },
// uncategorised, interviews } where `uncategorised` / `interviews` count the CURRENT window only.
function tally(rows, windows, nowMs) {
  const out = {}
  for (const days of windows) out[days] = { fields: {}, uncategorised: 0, interviews: 0 }
  for (const r of rows || []) {
    const t = Date.parse(r && r.answered_at)
    if (!Number.isFinite(t)) continue
    const cat = r.role_category || null
    for (const days of windows) {
      const edge = nowMs - days * DAY_MS
      const bucket = out[days]
      if (t >= edge) {
        bucket.interviews += 1
        if (!cat) { bucket.uncategorised += 1; continue }
        const f = bucket.fields[cat] || (bucket.fields[cat] = { current: 0, previous: 0 })
        f.current += 1
      } else if (t >= nowMs - 2 * days * DAY_MS && cat) {
        const f = bucket.fields[cat] || (bucket.fields[cat] = { current: 0, previous: 0 })
        f.previous += 1
      }
    }
  }
  return out
}

// One window's tally -> what the admin sees and what the public page would receive.
//   adds: { [category]: extra current-window reports } — the simulation. Real counts are never altered, only reported
//   next to the simulated ones.
function rank(bucket, { minReports, adds = {} }) {
  const floor = Math.max(Number(minReports) || 0, 1)
  const names = new Set([...Object.keys(bucket.fields), ...Object.keys(adds)])
  const entries = [...names].map(category => {
    const f = bucket.fields[category] || { current: 0, previous: 0 }
    const simulated = Math.max(0, Math.floor(Number(adds[category]) || 0))
    const effective = f.current + simulated
    return { category, current: f.current, previous: f.previous, simulated, effective, qualifies: effective >= floor, needed: Math.max(0, floor - effective) }
  })
  entries.sort((a, b) => (b.qualifies - a.qualifies) || (b.effective - a.effective) || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0))
  const listed = entries.filter(e => e.qualifies).slice(0, MAX_LISTED)
  const rankOf = new Map(listed.map((e, i) => [e.category, i + 1]))
  return {
    floor,
    fields: entries.map(e => ({ ...e, rank: rankOf.get(e.category) || null, changePct: changePct(e.effective, e.previous) })),
    qualifying: entries.filter(e => e.qualifies).length,
    uncategorised: bucket.uncategorised,
    interviews: bucket.interviews,
    // Exactly the shape of GET /api/stats `hotCategories[7|30]`.
    publicRows: listed.map(e => ({ category: e.category, interviews: e.effective, changePct: changePct(e.effective, e.previous) })),
  }
}

module.exports = { tally, rank, DAY_MS, MAX_LISTED }
