// Twice-monthly commission payout cycles: the 1st-15th, and the 16th
// through the last day of the month. Fixed business rule, not
// configurable per-partner (every partner is paid on the same schedule) —
// deliberately a pure function of a date, computed on demand from
// commission_ledger.created_at, rather than a stored/precomputed value.
// That means changing the rule later (e.g. to weekly) needs no backfill:
// every existing ledger row still has a real created_at to recompute from.
//
// All dates are UTC. created_at columns are timestamptz; using UTC
// consistently here means a commission earned at 23:50 UTC on the 15th is
// never accidentally bucketed into the 16th-end cycle depending on server
// timezone, and vice versa.

function startOfCycleContaining(date) {
  const d = new Date(date)
  const year  = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const day   = d.getUTCDate()
  return day <= 15
    ? new Date(Date.UTC(year, month, 1, 0, 0, 0, 0))
    : new Date(Date.UTC(year, month, 16, 0, 0, 0, 0))
}

function endOfCycleContaining(date) {
  const d = new Date(date)
  const year  = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const day   = d.getUTCDate()
  if (day <= 15) return new Date(Date.UTC(year, month, 15, 23, 59, 59, 999))
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate() // day 0 of next month = last day of this one
  return new Date(Date.UTC(year, month, lastDay, 23, 59, 59, 999))
}

// { start, end } for the cycle a given date falls in.
function cycleBounds(date) {
  return { start: startOfCycleContaining(date), end: endOfCycleContaining(date) }
}

// Stable string key for grouping/deduping cycles, independent of exact time.
function cycleKey(start) {
  const d = new Date(start)
  const half = d.getUTCDate() <= 15 ? 'A' : 'B'
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${half}`
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function cycleLabel(start, end) {
  const s = new Date(start), e = new Date(end)
  const month = MONTH_NAMES[s.getUTCMonth()]
  return `${month} ${s.getUTCDate()}\u2013${e.getUTCDate()}, ${s.getUTCFullYear()}`
}

// The last `count` cycles up to and including the one `now` falls in,
// most-recent-first. Used to build a fixed-size "recent cycles" view even
// for a brand-new partner with no ledger activity yet.
function recentCycles(count, now = new Date()) {
  const cycles = []
  let cursor = new Date(now)
  for (let i = 0; i < count; i++) {
    const { start, end } = cycleBounds(cursor)
    cycles.push({
      key:   cycleKey(start),
      label: cycleLabel(start, end),
      start: start.toISOString(),
      end:   end.toISOString(),
      isCurrent: i === 0
    })
    // Step into the previous cycle: one millisecond before this cycle's start.
    cursor = new Date(start.getTime() - 1)
  }
  return cycles
}

module.exports = { cycleBounds, cycleKey, cycleLabel, recentCycles }
