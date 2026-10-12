import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { purgeDeadSessions, purgeOldClaudeUsage, runRetention } from '../src/services/retention.service.js'
import { checkEmailDelivery } from '../src/lib/health.js'

// Database layer audit (migration 0077): retention RPCs, Claude usage endpoint, email_logs column fix.

let realErr; beforeEach(() => { realErr = console.error; console.error = () => {} }); afterEach(() => { console.error = realErr })

describe('purge RPC draining', () => {
  const dbReturning = (counts, calls = []) => createFakeSupabase(q => {
    if (q.op === 'rpc') { calls.push(q); return { data: counts.length ? counts.shift() : 0, error: null } }
  })
  it('purge_dead_sessions: one round when the batch is not filled', async () => {
    const db = dbReturning([12])
    expect(await purgeDeadSessions(db)).toEqual({ deleted: 12 })
    const c = db.calls.filter(x => x.op === 'rpc')
    expect(c).toHaveLength(1)
    expect(c[0].name).toBe('purge_dead_sessions')
    expect(c[0].args).toEqual({ p_days: 14, p_batch: 5000 })
  })
  it('drains a backlog over several rounds, capped at 5', async () => {
    const db = dbReturning([5000, 5000, 5000, 5000, 5000, 5000, 5000])
    expect(await purgeDeadSessions(db)).toEqual({ deleted: 25000 })
    expect(db.calls.filter(x => x.op === 'rpc')).toHaveLength(5)
  })
  it('purge_old_claude_usage uses 400 days and a bigger batch', async () => {
    const db = dbReturning([3])
    expect(await purgeOldClaudeUsage(db)).toEqual({ deleted: 3 })
    expect(db.calls.find(x => x.op === 'rpc').args).toEqual({ p_days: 400, p_batch: 20000 })
  })
  it('reports an rpc error (e.g. migration not applied) without throwing, keeping the count so far', async () => {
    const db = createFakeSupabase(q => q.op === 'rpc' ? { data: null, error: { message: 'function not found' } } : undefined)
    expect(await purgeDeadSessions(db)).toEqual({ deleted: 0, error: 'function not found' })
  })
  it('reports a thrown error without throwing', async () => {
    const db = { rpc: async () => { throw new Error('network') } }
    expect(await purgeOldClaudeUsage(db)).toEqual({ deleted: 0, error: 'network' })
  })
  it('runRetention includes both new steps', async () => {
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') return { data: q.name === 'purge_dead_sessions' ? 7 : 2, error: null }
      if (q.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    })
    const r = await runRetention({}, db, Date.parse('2026-10-01T00:00:00Z'))
    expect(r.sessions).toEqual({ deleted: 7 })
    expect(r.claudeUsage).toEqual({ deleted: 2 })
  })
})

describe('checkEmailDelivery', () => {
  it('filters on sent_at, the column email_logs actually has', async () => {
    const db = createFakeSupabase(() => ({ data: [], error: null }))
    await checkEmailDelivery(db, Date.parse('2026-10-01T12:00:00Z'))
    const f = db.calls[0].filters.find(x => x[0] === 'gte')
    expect(f[1]).toBe('sent_at')
    expect(f[2]).toBe('2026-10-01T11:00:00.000Z')
  })
  it('detects an outage: 5 failures, no successes', async () => {
    const rows = Array.from({ length: 5 }, () => ({ status: 'failed' }))
    const db = createFakeSupabase(() => ({ data: rows, error: null }))
    expect((await checkEmailDelivery(db)).ok).toBe(false)
  })
})

describe('adminClaudeUsage', () => {
  const rows = [
    { day: '2026-10-01', label: 'scan', model: 'm', calls: 2, input_tokens: 1000, output_tokens: 500 },
    { day: '2026-10-02', label: 'scan', model: 'm', calls: 1, input_tokens: 500, output_tokens: 100 },
    { day: '2026-10-02', label: 'fix', model: 'm', calls: 1, input_tokens: 3000, output_tokens: 2000 },
  ]
  const setup = (opts = {}) => {
    const db = createFakeSupabase(q => {
      if (opts.error) return { data: null, error: opts.error }
      if (q.name === 'claude_usage_summary') return { data: rows, error: null }
      if (q.name === 'claude_usage_totals') return { data: [{ calls: 4, input_tokens: 4500, output_tokens: 2600, scans: 2 }], error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    const ctx = (query = {}, env = {}) => ({ env, req: { query: k => query[k], param: () => 'x', json: async () => ({}) }, get: () => ({ id: 'a' }), json: (body, status = 200) => ({ body, status }) })
    return { mod, restore, ctx, db }
  }
  let t; afterEach(() => t?.restore())

  it('aggregates by label and day, biggest label first, newest day first', async () => {
    t = setup()
    const r = await t.mod.adminClaudeUsage(t.ctx())
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.days).toBe(30)
    expect(d.totals).toMatchObject({ calls: 4, inputTokens: 4500, outputTokens: 2600, scans: 2, tokensPerScan: 3550, estimatedUsd: null })
    expect(d.byLabel.map(l => l.label)).toEqual(['fix', 'scan'])
    expect(d.byLabel[1]).toMatchObject({ calls: 3, inputTokens: 1500, outputTokens: 600 })
    expect(d.byDay.map(x => x.day)).toEqual(['2026-10-02', '2026-10-01'])
    expect(d.priced).toBe(false)
  })
  it('prices only when both rates are configured', async () => {
    t = setup()
    const r = await t.mod.adminClaudeUsage(t.ctx({}, { CLAUDE_USD_PER_MTOK_INPUT: '3', CLAUDE_USD_PER_MTOK_OUTPUT: '15' }))
    expect(r.body.data.priced).toBe(true)
    expect(r.body.data.totals.estimatedUsd).toBe(0.05)
    const r2 = await t.mod.adminClaudeUsage(t.ctx({}, { CLAUDE_USD_PER_MTOK_INPUT: '3' }))
    expect(r2.body.data.priced).toBe(false)
  })
  it('clamps ?days to 1..400 and falls back to 30', async () => {
    t = setup()
    const days = async q => (await t.mod.adminClaudeUsage(t.ctx({ days: q }))).body.data.days
    expect(await days('9999')).toBe(400)
    expect(await days('0')).toBe(30)
    expect(await days('-5')).toBe(1)
    expect(await days('abc')).toBe(30)
    expect(await days('7')).toBe(7)
  })
  it('503s with a hint when migration 0077 is not applied', async () => {
    t = setup({ error: { code: 'PGRST202', message: 'Could not find the function public.claude_usage_summary' } })
    const r = await t.mod.adminClaudeUsage(t.ctx())
    expect(r.status).toBe(503)
    expect(r.body.message).toMatch(/0077/)
  })
  it('is routed behind the admin router', async () => {
    const fs = await import('node:fs')
    expect(fs.readFileSync(new URL('../src/routes/admin.routes.js', import.meta.url), 'utf8')).toMatch(/get\('\/claude-usage', c\.adminClaudeUsage\)/)
  })
})
