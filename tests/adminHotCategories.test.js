import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const hot = require('../src/lib/hotCategories')
const constants = require('../src/config/constants')

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const ago = (days) => new Date(NOW - days * DAY).toISOString()
const rep = (category, days) => ({ role_category: category, answered_at: ago(days) })
const many = (category, n, days = 1) => Array.from({ length: n }, () => rep(category, days))

describe('lib/hotCategories — tally mirrors the public_hot_categories window rules', () => {
  it('splits reports into the current window and the period before it, and ignores anything older', () => {
    const t = hot.tally([rep('sales', 1), rep('sales', 6.9), rep('sales', 8), rep('sales', 13.9), rep('sales', 15)], [7, 30], NOW)
    expect(t[7].fields.sales).toEqual({ current: 2, previous: 2 })   // 15 days old is outside both 7-day windows
    expect(t[30].fields.sales).toEqual({ current: 5, previous: 0 })
  })
  it('counts a report with no field as an interview but never as a ranked field', () => {
    const t = hot.tally([rep(null, 1), rep('legal', 1), { role_category: '', answered_at: ago(2) }], [7], NOW)
    expect(t[7].interviews).toBe(3)
    expect(t[7].uncategorised).toBe(2)
    expect(Object.keys(t[7].fields)).toEqual(['legal'])
  })
  it('skips rows with an unreadable date instead of throwing', () => {
    const t = hot.tally([{ role_category: 'sales', answered_at: 'garbage' }, { role_category: 'sales' }, null], [7], NOW)
    expect(t[7].interviews).toBe(0)
  })
})

describe('lib/hotCategories — rank mirrors the SQL ordering, floor, limit and arrow', () => {
  const bucket = (fields, extra = {}) => ({ fields, uncategorised: 0, interviews: 0, ...extra })
  it('lists only fields at or over the threshold, highest first, ties by name', () => {
    const r = hot.rank(bucket({ sales: { current: 10, previous: 0 }, legal: { current: 10, previous: 0 }, design: { current: 12, previous: 0 }, finance: { current: 9, previous: 0 } }), { minReports: 10 })
    expect(r.publicRows.map(x => x.category)).toEqual(['design', 'legal', 'sales'])
    expect(r.fields.find(f => f.category === 'finance')).toMatchObject({ qualifies: false, needed: 1, rank: null })
    expect(r.fields.map(f => f.category)).toEqual(['design', 'legal', 'sales', 'finance'])   // qualifiers first, then the rest by count
    expect(r.qualifying).toBe(3)
  })
  it('a floor below 1 behaves as 1, like greatest(p_min, 1)', () => {
    const r = hot.rank(bucket({ sales: { current: 0, previous: 4 }, legal: { current: 1, previous: 0 } }), { minReports: 0 })
    expect(r.publicRows.map(x => x.category)).toEqual(['legal'])
  })
  it('returns at most 12 fields and marks the rest as qualifying but unranked', () => {
    const fields = {}
    for (let i = 0; i < 14; i++) fields[`f${String(i).padStart(2, '0')}`] = { current: 20 - i, previous: 0 }
    const r = hot.rank(bucket(fields), { minReports: 5 })
    expect(r.publicRows).toHaveLength(12)
    expect(r.qualifying).toBe(14)
    expect(r.fields.find(f => f.category === 'f13')).toMatchObject({ qualifies: true, rank: null })
  })
  it('quotes the arrow only against a previous period big enough to mean something', () => {
    const r = hot.rank(bucket({ sales: { current: 12, previous: 10 }, legal: { current: 12, previous: 2 } }), { minReports: 10 })
    expect(r.publicRows.find(x => x.category === 'sales').changePct).toBe(20)
    expect(r.publicRows.find(x => x.category === 'legal').changePct).toBeNull()
  })
  it('simulated reports are added on top and reported separately; the real count is untouched', () => {
    const r = hot.rank(bucket({ sales: { current: 3, previous: 0 } }), { minReports: 10, adds: { sales: 7, legal: 10 } })
    expect(r.fields.find(f => f.category === 'sales')).toMatchObject({ current: 3, simulated: 7, effective: 10, qualifies: true })
    expect(r.fields.find(f => f.category === 'legal')).toMatchObject({ current: 0, simulated: 10, qualifies: true })
    expect(r.publicRows.map(x => x.interviews)).toEqual([10, 10])
  })
  it('pretend reports in the period before drive the arrow, and are reported separately from the real previous count', () => {
    const r = hot.rank(bucket({ sales: { current: 12, previous: 2 } }), { minReports: 10, prevAdds: { sales: 8, legal: 20 } })
    const sales = r.fields.find(f => f.category === 'sales')
    expect(sales).toMatchObject({ previous: 10, simulatedPrevious: 8 })
    expect(r.publicRows.find(x => x.category === 'sales').changePct).toBe(20)   // 12 now vs 10 before; the real 2 alone would quote nothing
    expect(r.fields.find(f => f.category === 'legal')).toMatchObject({ current: 0, previous: 20, qualifies: false })   // a previous-only field is listed, never ranked
  })
})

// ── controller ───────────────────────────────────────────────────────────────────────────────────
let restore
afterEach(() => { restore?.(); restore = undefined })

function setup(rowsByPage) {
  let page = 0
  const db = createFakeSupabase(q => {
    if (q.table === 'scan_outcomes') return { data: rowsByPage[Math.min(page++, rowsByPage.length - 1)], error: null }
  })
  const loaded = loadWithStubs('controllers/admin-hot-categories.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  restore = loaded.restore
  return { c: loaded.mod, db }
}
const ctxFor = (body) => ({
  env: {}, get: () => ({ id: 'admin-1' }),
  req: { json: async () => { if (body === undefined) throw new Error('no body'); return body } },
  json: (b, status = 200) => ({ body: b, status }),
})
const realNow = Date.now
function freezeTime() { Date.now = () => NOW }
afterEach(() => { Date.now = realNow })

describe('GET /api/admin/hot-categories', () => {
  it('shows each field against the threshold and says the homepage falls back to samples when none qualify', async () => {
    freezeTime()
    const { c } = setup([[...many('sales', 4), ...many('legal', 2), rep(null, 1)]])
    const res = await c.adminHotCategories(ctxFor())
    const d = res.body.data
    expect(d).toMatchObject({ simulated: false, threshold: constants.HOT_CATEGORY_MIN_REPORTS, windows: [7, 30], truncated: false })
    expect(d.perWindow[7].fields.map(f => [f.category, f.current, f.needed])).toEqual([['sales', 4, 6], ['legal', 2, 8]])
    expect(d.perWindow[7]).toMatchObject({ qualifying: 0, uncategorised: 1, interviews: 7, showsSample: true })
    expect(d.hotCategories[7]).toEqual([])
    expect(d.hotCategories.minReports).toBe(constants.HOT_CATEGORY_MIN_REPORTS)
  })
  it('once a field reaches the threshold the live window is real data, in the exact /api/stats shape', async () => {
    freezeTime()
    const { c } = setup([[...many('sales', 10), ...many('sales', 5, 9)]])
    const d = (await c.adminHotCategories(ctxFor())).body.data
    expect(d.perWindow[7].showsSample).toBe(false)
    expect(d.hotCategories[7]).toEqual([{ category: 'sales', interviews: 10, changePct: 100 }])
  })
  it('asks only for interview reports in the last two longest-windows, selecting just the two columns it needs', async () => {
    freezeTime()
    const { c, db } = setup([[]])
    await c.adminHotCategories(ctxFor())
    const q = db.calls.find(x => x.table === 'scan_outcomes')
    expect(eqValue(q, 'outcome')).toBe('INTERVIEW')
    expect(q.cols).toBe('role_category, answered_at')
    expect(q.filters.find(f => f[0] === 'gte' && f[1] === 'answered_at')[2]).toBe(ago(60))
  })
  it('reads every page of reports, and flags a truncated answer instead of silently under-counting', async () => {
    freezeTime()
    const full = Array.from({ length: 1000 }, () => rep('sales', 1))
    const { c, db } = setup([full, full.slice(0, 10)])
    const d = (await c.adminHotCategories(ctxFor())).body.data
    expect(d.perWindow[7].fields[0].current).toBe(1010)
    expect(db.calls.filter(x => x.table === 'scan_outcomes').map(x => x.range)).toEqual([[0, 999], [1000, 1999]])
    const cap = setup([full])   // never-ending full pages
    const t = (await cap.c.adminHotCategories(ctxFor())).body.data
    expect(t.truncated).toBe(true)
  })
  it('a database error is thrown to the error handler, not turned into an empty "all clear"', async () => {
    const db = createFakeSupabase(q => q.table === 'scan_outcomes' ? { data: null, error: { message: 'down' } } : undefined)
    const loaded = loadWithStubs('controllers/admin-hot-categories.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    restore = loaded.restore
    await expect(loaded.mod.adminHotCategories(ctxFor())).rejects.toMatchObject({ message: 'down' })
  })
})

describe('POST /api/admin/hot-categories/simulate', () => {
  it('lets a field cross the line with simulated reports and shows what the page would receive, without touching the real counts', async () => {
    freezeTime()
    const { c } = setup([many('sales', 4)])
    const d = (await c.adminSimulateHotCategories(ctxFor({ adds: [{ category: 'sales', days7: 6 }] }))).body.data
    expect(d.simulated).toBe(true)
    expect(d.perWindow[7].fields[0]).toMatchObject({ category: 'sales', current: 4, simulated: 6, effective: 10, qualifies: true, rank: 1 })
    expect(d.hotCategories[7]).toEqual([{ category: 'sales', interviews: 10, changePct: null }])
    expect(d.perWindow[7].showsSample).toBe(false)
    expect(d.perWindow[30].showsSample).toBe(true)   // days30 was not simulated, and 4 is still under 10
  })
  it('prev7 / prev30 simulate the period before each window, so the arrows can be tested', async () => {
    freezeTime()
    const { c } = setup([many('sales', 12)])
    const d = (await c.adminSimulateHotCategories(ctxFor({ adds: [{ category: 'sales', prev7: 8, prev30: 6 }] }))).body.data
    expect(d.hotCategories[7]).toEqual([{ category: 'sales', interviews: 12, changePct: 50 }])    // 12 vs 8
    expect(d.hotCategories[30]).toEqual([{ category: 'sales', interviews: 12, changePct: 100 }])  // 12 vs 6
    expect(d.perWindow[7].fields[0]).toMatchObject({ simulated: 0, simulatedPrevious: 8, previous: 8 })
  })
  it('a lower threshold alone changes the outcome', async () => {
    freezeTime()
    const { c } = setup([[...many('sales', 4), ...many('legal', 3)]])
    const d = (await c.adminSimulateHotCategories(ctxFor({ minReports: 3 }))).body.data
    expect(d.threshold).toBe(3)
    expect(d.defaultThreshold).toBe(constants.HOT_CATEGORY_MIN_REPORTS)
    expect(d.hotCategories[7].map(r => r.category)).toEqual(['sales', 'legal'])
    expect(d.hotCategories.minReports).toBe(3)
  })
  it('an empty or missing body simulates nothing (same as the real counts)', async () => {
    freezeTime()
    const { c } = setup([many('sales', 4)])
    const d = (await c.adminSimulateHotCategories(ctxFor())).body.data
    expect(d.perWindow[7].fields[0]).toMatchObject({ simulated: 0, effective: 4 })
  })
  it('refuses unknown fields and out-of-range numbers', async () => {
    const { c } = setup([[]])
    for (const body of [{ minReports: 0 }, { minReports: 1001 }, { minReports: 2.5 }, { adds: [{ category: 'wizardry', days7: 1 }] }, { adds: [{ category: 'sales', days7: -1 }] }, { adds: [{ category: 'sales', days30: 10001 }] }, { adds: [{ category: 'sales', prev7: -1 }] }, { adds: [{ category: 'sales', prev30: 10001 }] }]) {
      const res = await c.adminSimulateHotCategories(ctxFor(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })
  it('only ever reads: no insert, update, upsert, delete or rpc, and nothing in the audit log', async () => {
    freezeTime()
    const { c, db } = setup([many('sales', 4)])
    await c.adminSimulateHotCategories(ctxFor({ minReports: 2, adds: [{ category: 'legal', days7: 9, days30: 9 }] }))
    await c.adminHotCategories(ctxFor())
    expect(db.calls.every(q => q.op === 'select' && q.table === 'scan_outcomes')).toBe(true)
  })
})
