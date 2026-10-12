import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const { STATUS_GROUPS, STATUS_FILTERS, SCAN_STATUSES, applyScanFilters } = require('../src/lib/scanSearch')

// Dashboard chips that mean several statuses (In progress, Needs a decision). The list and the
// filtered delete both read them through applyScanFilters, so they cannot disagree.

let t
afterEach(() => t?.restore())

function query() {
  const db = createFakeSupabase()
  return { db, q: db.from('scans') }
}

describe('scanSearch — status groups', () => {
  it('every group is made only of real statuses, and is a valid filter', () => {
    for (const [name, list] of Object.entries(STATUS_GROUPS)) {
      expect(STATUS_FILTERS).toContain(name)
      for (const s of list) expect(SCAN_STATUSES).toContain(s)
    }
    expect(STATUS_GROUPS.IN_PROGRESS).toEqual(['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING'])
    expect(STATUS_GROUPS.NEEDS_DECISION).toEqual(['COMPLETE_PASS', 'COMPLETE_FAIL'])
  })

  it('a group narrows with IN (...), a real status with EQ, anything else not at all', async () => {
    let { db, q } = query()
    await applyScanFilters(q, { status: 'IN_PROGRESS' })
    expect(db.calls[0].filters).toEqual([['in', 'status', STATUS_GROUPS.IN_PROGRESS]])
    ;({ db, q } = query())
    await applyScanFilters(q, { status: 'FIX_DELIVERED' })
    expect(db.calls[0].filters).toEqual([['eq', 'status', 'FIX_DELIVERED']])
    ;({ db, q } = query())
    await applyScanFilters(q, { status: 'NOPE' })
    expect(db.calls[0].filters).toEqual([])
  })
})

describe('getScanHistory — retries used and the public link', () => {
  const ctx = () => ({
    env: {}, get: k => (k === 'user' ? { id: 'u1' } : undefined),
    req: { query: () => undefined, param: () => undefined }, json: (body, status = 200) => ({ body, status }),
  })
  const row = over => ({ id: 's1', status: 'FIX_DELIVERED', ats_score: 55, fix_ats_score: 78, updated_at: '2026-09-01T00:05:00Z', ...over })

  it('selects the retry counter and returns it as fixRetryCount (0 when the column is empty)', async () => {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: [row({ fix_retry_count: 1 }), row({ id: 's2' })], error: null, count: 2 } : undefined))
    const loaded = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    t = loaded
    const { scans } = (await loaded.mod.getScanHistory(ctx())).body.data
    expect(db.calls[0].cols).toContain('fix_retry_count')
    expect(scans.map(s => s.fixRetryCount)).toEqual([1, 0])
  })

  it('returns the public verification link so the dashboard can copy it, null when there is none', async () => {
    const db = createFakeSupabase(q => (q.table === 'scans' ? { data: [row({ verification_url: 'https://passthrough.dev/v/ABC' }), row({ id: 's2' })], error: null, count: 2 } : undefined))
    const loaded = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    t = loaded
    const { scans } = (await loaded.mod.getScanHistory(ctx())).body.data
    expect(db.calls[0].cols).toContain('verification_url')
    expect(scans.map(s => s.verificationUrl)).toEqual(['https://passthrough.dev/v/ABC', null])
  })
})
