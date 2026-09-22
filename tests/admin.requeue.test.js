import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

function setup({ scan, claim = true, claimError = null, queueError = null }) {
  const state = { queue: [], claims: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.op === 'rpc') { state.claims.push([q.name, q.args]); return { data: claim, error: claimError } }
  })
  const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  const c = { env: { FIX_QUEUE: { send: async m => { if (queueError) throw queueError; state.queue.push(m) } } }, req: { param: () => 's1' }, json: (body, status = 200) => ({ body, status }) }
  return { mod, restore, state, c }
}
let t; afterEach(() => t?.restore())

describe('adminRequeueFix', () => {
  it('re-queues a paid scan via the atomic claim, with no attempt cap', async () => {
    t = setup({ scan: { id: 's1', status: 'ERROR', fix_purchased: true, fix_tier: 'FIX' } })
    const res = await t.mod.adminRequeueFix(t.c)
    expect(res.body.success).toBe(true)
    expect(t.state.claims).toEqual([['claim_errored_fix', { p_scan_id: 's1', p_max: 1000 }]])
    expect(t.state.queue).toEqual([{ type: 'generateFix', scanId: 's1' }])
  })
  it('a BADGE-tier scan goes to generateBadge', async () => {
    t = setup({ scan: { id: 's1', status: 'ERROR', fix_purchased: true, fix_tier: 'BADGE' } })
    await t.mod.adminRequeueFix(t.c)
    expect(t.state.queue[0].type).toBe('generateBadge')
  })
  it('404 for an unknown scan; 400 when nothing was purchased', async () => {
    t = setup({ scan: null }); expect((await t.mod.adminRequeueFix(t.c)).status).toBe(404); t.restore()
    t = setup({ scan: { id: 's1', status: 'ERROR', fix_purchased: false } })
    const res = await t.mod.adminRequeueFix(t.c)
    expect(res.status).toBe(400); expect(t.state.queue).toHaveLength(0)
  })
  it('409 — and NOTHING enqueued — when the scan is not currently in ERROR (a live job or a delivered fix is never disturbed)', async () => {
    t = setup({ scan: { id: 's1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: 'FIX' }, claim: false })
    const res = await t.mod.adminRequeueFix(t.c)
    expect(res.status).toBe(409); expect(res.body.message).toContain('FIX_DELIVERED')
    expect(t.state.queue).toHaveLength(0)
  })
  it('an RPC error and a queue error both surface as errors (not silent success)', async () => {
    t = setup({ scan: { id: 's1', status: 'ERROR', fix_purchased: true, fix_tier: 'FIX' }, claimError: new Error('rpc') })
    await expect(t.mod.adminRequeueFix(t.c)).rejects.toThrow('rpc'); t.restore()
    t = setup({ scan: { id: 's1', status: 'ERROR', fix_purchased: true, fix_tier: 'FIX' }, queueError: new Error('queue') })
    await expect(t.mod.adminRequeueFix(t.c)).rejects.toThrow('queue')
  })
})
