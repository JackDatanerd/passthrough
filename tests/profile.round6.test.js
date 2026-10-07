import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import scanSearch from '../src/lib/scanSearch.js'

// Profile & Dashboard (Section 6), audit round 6: filtered scan purge, keyset export paging,
// the export's pending-email / mail-history honesty, and the shared search definition.

function setup(resolver, { bucket } = {}) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/profile.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/verification.js': { recordTombstones: async () => {} },
  })
  const c = (over = {}) => ({
    env: { RESUMES_BUCKET: bucket || { delete: async () => {} } },
    get: () => ({ id: over.userId ?? 'u1' }),
    req: { json: async () => over.body ?? {}, query: k => over.query?.[k] },
    json: (body, status = 200) => ({ body, status }),
    body: (raw, status = 200, headers = {}) => ({ raw, status, headers }),
  })
  return { mod, restore, c, db }
}
let t
afterEach(() => t?.restore())

describe('lib/scanSearch — one definition of the dashboard filters', () => {
  const { sanitizeSearch, HISTORY_SEARCH, applyScanFilters, SCAN_STATUSES } = scanSearch
  it('strips everything with meaning inside a PostgREST .or() string or an ilike pattern', () => {
    expect(sanitizeSearch('  a,b(c)"d%e\\f*g  ')).toBe('abcdefg')
    expect(sanitizeSearch(undefined)).toBe('')
    expect(sanitizeSearch('%%')).toBe('')
  })
  it('matches file name, candidate first name and job title', () => {
    expect(HISTORY_SEARCH('x')).toBe('resume_original_name.ilike.%x%,candidate_first_name.ilike.%x%,job_title.ilike.%x%')
  })
  it('applyScanFilters narrows by search and by an allowlisted status only', () => {
    const calls = []
    const q = { or: e => { calls.push(['or', e]); return q }, eq: (c, v) => { calls.push(['eq', c, v]); return q } }
    applyScanFilters(q, { search: 'pm', status: 'ERROR' })
    expect(calls).toEqual([['or', HISTORY_SEARCH('pm')], ['eq', 'status', 'ERROR']])
    calls.length = 0
    applyScanFilters(q, { search: '', status: 'NOT_A_STATUS' })
    expect(calls).toEqual([])
    expect(SCAN_STATUSES).toContain('FIX_DELIVERED')
  })
})

describe('deleteScanHistory — deleting only what a dashboard filter shows', () => {
  const R = id => ({ id, status: 'ERROR', updated_at: '2020-01-01', resume_path: `r/${id}.pdf`, resume_ats_path: null, resume_pdf_path: null })
  function purge(list, remaining = 0) {
    return setup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.selectOpts?.head) return { count: remaining, error: null }
      if (q.table === 'scans' && q.op === 'select') return { data: list, error: null }
      if (q.table === 'payments') return { data: [], error: null }
      if (q.table === 'scans' && q.op === 'delete') return { data: q.filters.find(f => f[0] === 'in')[2].map(id => ({ id })), error: null }
    })
  }
  const listCall = () => t.db.calls.find(c => c.table === 'scans' && c.op === 'select' && !c.selectOpts?.head)
  const countCall = () => t.db.calls.find(c => c.table === 'scans' && c.selectOpts?.head)

  it('?status= narrows BOTH the batch and the remaining count', async () => {
    t = purge([R('a')], 3)
    const res = await t.mod.deleteScanHistory(t.c({ query: { status: 'ERROR' } }))
    expect(res.body.data).toEqual({ deleted: 1, remaining: 3 })
    expect(listCall().filters).toContainEqual(['eq', 'status', 'ERROR'])
    expect(countCall().filters).toContainEqual(['eq', 'status', 'ERROR'])
  })
  it('?search= is sanitized and applied the way the history list applies it', async () => {
    t = purge([R('a')])
    await t.mod.deleteScanHistory(t.c({ query: { search: 'pm,(x)%' } }))
    expect(listCall().or).toContain(scanSearch.HISTORY_SEARCH('pmx'))
    expect(countCall().or).toEqual([scanSearch.HISTORY_SEARCH('pmx')])
  })
  it('keeps the in-flight guard alongside a search (two .or() calls are ANDed)', async () => {
    t = purge([R('a')])
    await t.mod.deleteScanHistory(t.c({ query: { search: 'pm' } }))
    expect(listCall().or).toHaveLength(2)
    expect(listCall().or[0]).toMatch(/^status\.not\.in\./)
  })
  it('an unknown status is refused, not ignored — ignoring it would delete everything', async () => {
    t = purge([R('a')])
    const res = await t.mod.deleteScanHistory(t.c({ query: { status: 'DROP_TABLE' } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })
  it('a search that sanitizes to nothing (and no status) is refused rather than widening to everything', async () => {
    t = purge([R('a')])
    const res = await t.mod.deleteScanHistory(t.c({ query: { search: '%%' } }))
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Settings/)
    expect(t.db.calls).toHaveLength(0)
  })
  it('an empty search with a valid status is fine (the status carries the filter)', async () => {
    t = purge([R('a')])
    const res = await t.mod.deleteScanHistory(t.c({ query: { search: '%', status: 'ERROR' } }))
    expect(res.status).toBe(200)
  })
  it('no filters at all still means the whole history, exactly as before', async () => {
    t = purge([R('a')])
    await t.mod.deleteScanHistory(t.c())
    expect(listCall().or).toHaveLength(1)
    expect(listCall().filters.some(f => f[1] === 'status')).toBe(false)
  })
})

describe('exportMyData — keyset paging, honest mail list, live pending email', () => {
  const CREATED = '2026-10-01T12:00:00.123456+00:00'
  const ID = '22222222-2222-2222-2222-222222222222'
  const base = {
    users: { data: { name: 'Jane', email: 'jane@x.com', email_verified: true, free_fix_credits: 0, created_at: 'c', saved_profile: null, pending_email: null, pending_email_expiry: null, notify_scan_results: true }, error: null },
    payments: { data: [], error: null }, user_sessions: { data: [], error: null }, email_logs: { data: [], error: null },
  }
  const full = Array.from({ length: 250 }, (_, i) => ({ id: i === 249 ? ID : `s${i}`, created_at: i === 249 ? CREATED : 'x' }))
  const resolver = (data, total) => q => q.table === 'scans' ? { data, count: total, error: null } : base[q.table]
  const scanCalls = () => t.db.calls.filter(c => c.table === 'scans')

  it('a FULL part hands back a cursor to the next one: the last row\'s (created_at|id)', async () => {
    t = setup(resolver(full, 600))
    const res = await t.mod.exportMyData(t.c())
    expect(res.headers['X-Export-Cursor']).toBe(`${CREATED}|${ID}`)
  })
  it('a short (last) part has no successor and no cursor', async () => {
    t = setup(resolver(full.slice(0, 40), 290))
    expect((await t.mod.exportMyData(t.c({ query: { part: '2' } }))).headers['X-Export-Cursor']).toBeUndefined()
  })
  it('?cursor= pages by key, not offset: strictly after (created_at, id), no range(), real total from a head count', async () => {
    t = setup(resolver(full.slice(0, 100), 600))
    const res = await t.mod.exportMyData(t.c({ query: { part: '3', cursor: `${CREATED}|${ID}` } }))
    const q = scanCalls()[0]
    expect(q.range).toBeUndefined()
    expect(q.limit).toBe(250)
    expect(q.or).toEqual([`created_at.lt.${CREATED},and(created_at.eq.${CREATED},id.lt.${ID})`])
    expect(q.orders.map(o => o[0])).toEqual(['created_at', 'id'])
    expect(q.filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(scanCalls().some(c => c.selectOpts?.head)).toBe(true)
    expect(JSON.parse(res.raw).export).toMatchObject({ part: 3, totalScans: 600 })
  })
  it('scans deleted since part 1 cannot turn a cursor part into a 404', async () => {
    t = setup(q => q.table === 'scans' ? { data: [], count: 100, error: null } : base[q.table])   // total now says 1 part
    const res = await t.mod.exportMyData(t.c({ query: { part: '2', cursor: `${CREATED}|${ID}` } }))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.raw).export.parts).toBeGreaterThanOrEqual(2)
  })
  it('a malformed cursor is never spliced into the filter: it falls back to the offset path', async () => {
    for (const bad of ['x', `${CREATED}|nope`, `2026-10-01T00:00:00Z|${ID},id.gt.0`, `2026-10-01T00:00:00Z)|${ID}`, '']) {
      t = setup(resolver(full.slice(0, 5), 5))
      await t.mod.exportMyData(t.c({ query: { part: '1', cursor: bad } }))
      const q = scanCalls()[0]
      expect(q.or, bad).toBeUndefined()
      expect(q.range, bad).toEqual([0, 249])
      t.restore()
    }
  })
  it('without a cursor a part past the end is still a 404', async () => {
    t = setup(resolver([], 100))
    expect((await t.mod.exportMyData(t.c({ query: { part: '4' } }))).status).toBe(404)
  })
  it('an EXPIRED staged email change is not exported as pending (the account\'s own read hides it too)', async () => {
    const users = { data: { ...base.users.data, pending_email: 'new@x.com', pending_email_expiry: '2020-01-01T00:00:00Z' }, error: null }
    t = setup(q => q.table === 'users' ? users : q.table === 'scans' ? { data: [], count: 0, error: null } : base[q.table])
    expect(JSON.parse((await t.mod.exportMyData(t.c())).raw).account.pendingEmail).toBeNull()
  })
  it('says which address the mail list is for, instead of passing it off as the complete history', async () => {
    t = setup(resolver([], 0))
    const out = JSON.parse((await t.mod.exportMyData(t.c())).raw)
    expect(out.emailsNote).toContain('jane@x.com')
    expect(out.emailsNote).toMatch(/earlier/)
  })
})
