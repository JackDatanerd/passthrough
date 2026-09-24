import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const DAY = 86400000

function setup({ supply = [], leads = [], state = null, rpcError = null, leadError = null, delivered = true } = {}) {
  const notices = []
  const store = new Map()
  if (state) store.set('leadmatch:state', JSON.stringify(state))
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc' && q.name === 'verified_candidate_counts') return rpcError ? { error: rpcError } : { data: supply, error: null }
    if (q.op === 'rpc' && q.name === 'open_lead_counts') return leadError ? { error: leadError } : { data: leads, error: null }
  })
  const { mod, restore } = loadWithStubs('services/lead-match.service.js', {
    'services/email.service.js': { sendOwnerNotice: async (env, subject, message) => { notices.push({ subject, message }); return delivered } },
  })
  const kv = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v) } }
  const env = { RATE_LIMIT_KV: kv, FRONTEND_URL: 'https://passthrough.dev' }
  return { mod, restore, notices, store, db, env, saved: () => JSON.parse(store.get('leadmatch:state')) }
}
const sup = (cat, n) => ({ role_category: cat, candidate_count: String(n) })
// open_lead_counts() rows: one per field, already tallied by the database.
const waiting = (...cats) => Object.entries(cats.reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {}))
  .map(([role_category, n]) => ({ role_category, lead_count: String(n) }))

let t
afterEach(() => t?.restore())

describe('computeAnnouncements', () => {
  it('names fields with open leads whose verified supply grew past what was last announced', () => {
    t = setup()
    expect(t.mod.computeAnnouncements({ sales: 3, legal: 1, design: 2 }, { sales: 2, legal: 1 }, { sales: 1, legal: 1 }))
      .toEqual([{ cat: 'sales', candidates: 3, before: 1, leads: 2 }])
  })
  it('ignores fields nobody is waiting on and fields with no supply', () => {
    t = setup()
    expect(t.mod.computeAnnouncements({ design: 5, sales: 0 }, { sales: 4 }, {})).toEqual([])
  })
})

describe('runLeadMatchSweep', () => {
  it('sends one digest to the owner for fields with waiting leads and new supply, and records what it announced', async () => {
    t = setup({ supply: [sup('sales', 2), sup('design', 4)], leads: waiting('sales', 'sales', 'legal') })
    const r = await t.mod.runLeadMatchSweep(t.env, t.db, NOW)
    expect(r).toEqual({ announced: 1, pending: 0 })
    expect(t.notices).toHaveLength(1)
    expect(t.notices[0].message).toContain('Sales: 2 open leads · 2 verified candidates')
    expect(t.notices[0].message).toContain('https://passthrough.dev/admin/leads?field=sales')
    expect(t.notices[0].message).not.toContain('Design')
    expect(t.saved()).toEqual({ supply: { sales: 2 }, sentAt: NOW })
  })
  it('takes waiting-lead counts from the database (open_lead_counts) instead of tallying a capped row fetch', async () => {
    t = setup({ supply: [sup('sales', 1)], leads: [] })
    await t.mod.runLeadMatchSweep(t.env, t.db, NOW)
    expect(t.db.calls.some(c => c.op === 'rpc' && c.name === 'open_lead_counts')).toBe(true)
    expect(t.db.calls.some(c => c.table === 'employer_leads')).toBe(false)
    expect(t.notices).toHaveLength(0)
  })
  it('counts every waiting lead, however many (a tally of 1500 is not clipped at a 1000-row response cap)', async () => {
    t = setup({ supply: [sup('sales', 1)], leads: [{ role_category: 'sales', lead_count: '1500' }] })
    await t.mod.runLeadMatchSweep(t.env, t.db, NOW)
    expect(t.notices[0].message).toContain('Sales: 1500 open leads')
  })
  it('records nothing when the owner notice was NOT delivered (no owner inbox), so a later run still announces it', async () => {
    t = setup({ supply: [sup('sales', 2)], leads: waiting('sales'), delivered: false })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).toEqual({ announced: 0, pending: 1 })
    expect(t.store.get('leadmatch:state')).toBeUndefined()      // baseline and sentAt untouched
    t.restore(); t = setup({ supply: [sup('sales', 2)], leads: waiting('sales') })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW + 3600_000)).toEqual({ announced: 1, pending: 0 })
  })
  it('does not repeat itself when supply has not grown', async () => {
    t = setup({ supply: [sup('sales', 2)], leads: waiting('sales'), state: { supply: { sales: 2 }, sentAt: NOW - 3 * DAY } })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).toEqual({ announced: 0, pending: 0 })
    expect(t.notices).toHaveLength(0)
  })
  it('announces growth again, but never more than once a day — growth in between is held, not lost', async () => {
    t = setup({ supply: [sup('sales', 5)], leads: waiting('sales'), state: { supply: { sales: 2 }, sentAt: NOW - 2 * 3600_000 } })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).toEqual({ announced: 0, pending: 1 })
    expect(t.notices).toHaveLength(0)
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW + DAY)).toEqual({ announced: 1, pending: 0 })
    expect(t.notices[0].message).toContain('5 verified candidates (was 2)')
  })
  it('lowers the baseline when supply falls (a revocation), so a later recovery counts as growth', async () => {
    t = setup({ supply: [sup('sales', 1)], leads: waiting('sales'), state: { supply: { sales: 4 }, sentAt: NOW - 3 * DAY } })
    await t.mod.runLeadMatchSweep(t.env, t.db, NOW)
    expect(t.saved().supply).toEqual({ sales: 1 })
    expect(t.notices).toHaveLength(0)
  })
  it('survives corrupt stored state, a missing KV, and query failures without throwing', async () => {
    t = setup({ supply: [sup('sales', 1)], leads: waiting('sales') })
    t.store.set('leadmatch:state', '{not json')
    expect((await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).announced).toBe(1)
    expect(await t.mod.runLeadMatchSweep({}, t.db, NOW)).toEqual({ skipped: 'no-kv' })
    t.restore(); t = setup({ rpcError: { message: 'no such function' } })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).toEqual({ error: 'no such function' })
    t.restore(); t = setup({ leadError: { message: 'db down' } })
    expect(await t.mod.runLeadMatchSweep(t.env, t.db, NOW)).toEqual({ error: 'db down' })
  })
})
