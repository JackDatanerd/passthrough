import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Profile & Dashboard (Section 6), round 14 — the profile migration's number, and the single-scan delete's in-flight rule.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')

describe('migration numbers are unique (two sessions both wrote 0083; the second silently lost its ledger row)', () => {
  it('no two migration files share a number', () => {
    const nums = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => f.slice(0, 4))
    expect(nums.filter((n, i) => nums.indexOf(n) !== i)).toEqual([])
  })
  it('the profile round 13 migration records its own number in the ledger and schema_version', () => {
    const sql = fs.readFileSync(path.join(dir, '0084_profile_dashboard_round13.sql'), 'utf8')
    expect(sql).toContain(`values (84, '0084_profile_dashboard_round13')`)
    expect(sql).toMatch(/'version', 84,/)
  })
})

let t
afterEach(() => t?.restore())
const HOUR = 3600_000

function setup({ stillThere }) {
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: { id: 's1', user_id: 'u1', status: 'COMPLETE_PASS', updated_at: new Date(Date.now() - 5 * HOUR).toISOString() }, error: null }
    if (q.table === 'payments') return { count: 0, error: null }
    if (q.table === 'scans' && q.op === 'delete') return { data: null, error: null }
  })
  const { mod, restore } = loadWithStubs('controllers/scan.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  const ctx = {
    env: { RESUMES_BUCKET: { delete: async () => {} } },
    get: k => (k === 'user' ? { id: 'u1', emailVerified: true } : undefined),
    req: { param: () => 's1', query: () => undefined, json: async () => ({}) },
    json: (body, status = 200) => ({ body, status }),
  }
  return { mod, restore, db, ctx, stillThere }
}

describe('DELETE /scan/:id repeats the in-flight rule on the delete itself', () => {
  it('carries the same status / updated_at condition as the batch purge', async () => {
    t = setup({})
    await t.mod.deleteScan(t.ctx)
    const del = t.db.calls.find(c => c.table === 'scans' && c.op === 'delete')
    expect(del.or.join(' ')).toMatch(/status\.not\.in\.\(PENDING,SCANNING,FIX_PURCHASED,FIX_GENERATING\),updated_at\.lte\./)
  })
  it('a scan that started work after the check is a 409, not a delete under its job', async () => {
    t = setup({})   // the delete matches nothing, and the scan is still there
    const res = await t.mod.deleteScan(t.ctx)
    expect(res.status).toBe(409)
  })
})
