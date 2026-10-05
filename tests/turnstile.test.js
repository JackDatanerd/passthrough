import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { verifyTurnstile, SITEVERIFY_URL } from '../src/lib/turnstile.js'

let realFetch, realErr, calls
beforeEach(() => { realFetch = globalThis.fetch; realErr = console.error; console.error = () => {}; calls = [] })
afterEach(() => { globalThis.fetch = realFetch; console.error = realErr })
const stub = (impl) => { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl() } }
const env = { TURNSTILE_SECRET_KEY: 'sek' }

describe('verifyTurnstile', () => {
  it('is a no-op (and never calls out) when no secret is configured', async () => {
    stub(() => { throw new Error('should not be called') })
    expect(await verifyTurnstile({}, undefined, '1.2.3.4')).toBe(true)
    expect(calls).toHaveLength(0)
  })
  it('rejects a missing or non-string token without calling Cloudflare', async () => {
    stub(() => { throw new Error('should not be called') })
    expect(await verifyTurnstile(env, undefined)).toBe(false)
    expect(await verifyTurnstile(env, '')).toBe(false)
    expect(await verifyTurnstile(env, 42)).toBe(false)
    expect(calls).toHaveLength(0)
  })
  it('posts secret, response and the client IP to siteverify and returns Cloudflare\'s verdict', async () => {
    stub(() => ({ ok: true, json: async () => ({ success: true }) }))
    expect(await verifyTurnstile(env, 'tok', '1.2.3.4')).toBe(true)
    expect(calls[0].url).toBe(SITEVERIFY_URL)
    const body = new URLSearchParams(calls[0].init.body.toString())
    expect(Object.fromEntries(body)).toEqual({ secret: 'sek', response: 'tok', remoteip: '1.2.3.4' })
    stub(() => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }))
    expect(await verifyTurnstile(env, 'tok')).toBe(false)
  })
  it('leaves remoteip out when the IP is unknown', async () => {
    stub(() => ({ ok: true, json: async () => ({ success: true }) }))
    await verifyTurnstile(env, 'tok', 'unknown')
    expect(new URLSearchParams(calls[0].init.body.toString()).has('remoteip')).toBe(false)
  })
  it('fails OPEN when Cloudflare is down, errors, or answers nonsense — an outage must not lose leads', async () => {
    stub(() => { throw new Error('network') })
    expect(await verifyTurnstile(env, 'tok')).toBe(true)
    stub(() => ({ ok: false, status: 503, json: async () => ({}) }))
    expect(await verifyTurnstile(env, 'tok')).toBe(true)
    stub(() => ({ ok: true, json: async () => ({ hello: 'world' }) }))
    expect(await verifyTurnstile(env, 'tok')).toBe(true)
    stub(() => ({ ok: true, json: async () => { throw new Error('bad json') } }))
    expect(await verifyTurnstile(env, 'tok')).toBe(true)
  })
})
