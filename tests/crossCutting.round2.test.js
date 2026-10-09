import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createClient } from '@supabase/supabase-js'
import errorHandler from '../src/middleware/errorHandler.js'
import securityHeaders from '../src/middleware/securityHeaders.js'
import normalizeThrown from '../src/middleware/normalizeThrown.js'
import { must, toError } from '../src/lib/db.js'
import * as rl from '../src/middleware/rateLimiter.js'

const dupClient = () => createClient('https://x.supabase.co', 'k', {
  global: { fetch: async () => new Response(JSON.stringify({ code: '23505', message: 'duplicate key', details: 'Key exists', hint: null }), { status: 409, headers: { 'content-type': 'application/json' } }) },
})
const build = () => {
  const app = new Hono()
  app.use('*', securityHeaders)
  app.onError(errorHandler)
  app.use('*', normalizeThrown)
  const sb = dupClient()
  app.post('/raw', async () => { const { error } = await sb.from('t').insert({ a: 1 }); if (error) throw error })
  app.post('/must', async () => { must(await sb.from('t').insert({ a: 1 }), 'insert') })
  app.post('/str', async () => { throw 'boom' })
  return app
}

describe('database errors reach errorHandler (round 2, B1)', () => {
  it('a raw supabase-js error object thrown by a controller becomes the 409 JSON, with security headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await build().request('/raw', { method: 'POST' })
    expect(r.status).toBe(409)
    expect((await r.json()).message).toBe('Already exists.')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('must() throws a real Error that keeps code/details/hint and the label', async () => {
    let caught
    try { must({ error: { code: '23505', message: 'dup', details: 'd', hint: 'h' } }, 'lbl') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ code: '23505', details: 'd', hint: 'h', message: 'lbl: dup' })
    const r = await build().request('/must', { method: 'POST' })
    expect(r.status).toBe(409)
  })
  it('a non-Error, non-object throw is a clean 500 JSON, never an escaped rejection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await build().request('/str', { method: 'POST' })
    expect(r.status).toBe(500)
    expect((await r.json()).success).toBe(false)
  })
  it('toError never copies status/expose from a plain object', () => {
    const e = toError({ message: 'm', status: 401, expose: true })
    expect(e.status).toBeUndefined(); expect(e.expose).toBeUndefined()
  })
})

describe('anonymous scan slot refund covers the per-IP ceiling too (round 2)', () => {
  it('refunds both buckets named by the key, and still accepts the old single key', async () => {
    const calls = []
    const store = new Map()
    const env = { RATE_LIMIT_KV: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); calls.push(k) }, delete: async () => {} } }
    const now = Date.now()
    for (const k of ['rl:anonscan:d:abc', 'rl:anonscanip:9.9.9.9', 'rl:anonscan:9.9.9.9'])
      store.set(k, JSON.stringify({ count: 3, windowStart: now, refunds: 0 }))
    await rl.refundAnonScanSlot(env, 'rl:anonscan:d:abc|rl:anonscanip:9.9.9.9')
    expect(JSON.parse(store.get('rl:anonscan:d:abc')).count).toBe(2)
    expect(JSON.parse(store.get('rl:anonscanip:9.9.9.9')).count).toBe(2)
    await rl.refundAnonScanSlot(env, 'rl:anonscan:9.9.9.9')
    expect(JSON.parse(store.get('rl:anonscan:9.9.9.9')).count).toBe(2)
    await rl.refundAnonScanSlot(env, 'rl:other:x|rl:anonscanip:9.9.9.9')   // wrong prefix: ignored
    expect(JSON.parse(store.get('rl:anonscanip:9.9.9.9')).count).toBe(2)
  })
})
