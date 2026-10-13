import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'

// CROSS-CUTTING round (dead-letter): a dead-lettered free scan handed back the daily counter and the anonymous slot,
// but never the per-IP daily ceiling slot (ipSlotKey) the queue message carries — and judged "spent today" by created_at
// even when a retry-scan had re-spent the slot (scan_slot_spent_at).
const require = createRequire(import.meta.url)
const rl = require('../src/middleware/rateLimiter.js')
const { handleDeadLetterBatch } = require('../src/services/deadletter.service.js')

let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

const run = async (row, body) => {
  const rpcs = [], refunds = []
  const orig = rl.refundQuota
  rl.refundQuota = async (_e, k, w, m) => { refunds.push([k, w, m]) }
  const db = createFakeSupabase(q => {
    if (q.table === 'scans' && q.op === 'update') return { data: [{ id: 's1', ...row }], error: null }
    if (q.op === 'rpc') rpcs.push(q)
  })
  try { await handleDeadLetterBatch({ messages: [{ body: { type: 'runAtsScan', scanId: 's1', ...body }, ack() {} }] }, {}, db, { sendOwnerAlert: async () => {} }) }
  finally { rl.refundQuota = orig }
  return { refunds, db }
}

describe('dead-lettered signed-in scan', () => {
  it('hands the per-IP ceiling slot back along with the daily slot', async () => {
    const r = await run({ user_id: 'u1', created_at: new Date().toISOString() }, { ipSlotKey: 'rl:scanip:1.2.3.4' })
    expect(r.refunds).toEqual([['rl:scanip:1.2.3.4', 24 * 3600, 10]])
  })
  it('does nothing for the IP ceiling when the message carries no key', async () => {
    const r = await run({ user_id: 'u1', created_at: new Date().toISOString() }, {})
    expect(r.refunds).toEqual([])
  })
  it('judges the slot by scan_slot_spent_at, not created_at (a retry re-spent it)', async () => {
    const r = await run({ user_id: 'u1', created_at: '2020-01-01T00:00:00Z', scan_slot_spent_at: new Date().toISOString() }, { ipSlotKey: 'rl:scanip:1.2.3.4' })
    expect(r.refunds.length).toBe(1)
  })
  it('does not refund a slot spent more than a day ago', async () => {
    const r = await run({ user_id: 'u1', created_at: '2020-01-01T00:00:00Z' }, { ipSlotKey: 'rl:scanip:1.2.3.4' })
    expect(r.refunds).toEqual([])
  })
  it('never touches the IP ceiling for an anonymous scan', async () => {
    const r = await run({ user_id: null, created_at: new Date().toISOString() }, { ipSlotKey: 'rl:scanip:1.2.3.4', anonRlKey: 'rl:anonscan:9.9.9.9' })
    expect(r.refunds).toEqual([])
  })
})
