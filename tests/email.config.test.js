import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sendViaResend } from '../src/config/email.js'

const env = { RESEND_API_KEY: 're_test' }
const msg = { from: 'a@b.c', to: 'x@y.z', subject: 's', html: '<p>h</p>', text: 'h' }
const FAST = { retryDelaysMs: [1, 1] }
const resp = (status, body = '{}', headers = {}) => new Response(body, { status, headers })

let realFetch, calls
beforeEach(() => { realFetch = globalThis.fetch; calls = [] })
afterEach(() => { globalThis.fetch = realFetch })
const script = (...responses) => { globalThis.fetch = async (url, init) => { calls.push({ url, init }); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; if (r instanceof Error) throw r; return r } }

describe('sendViaResend', () => {
  it('sends once on success, with auth, text part and an idempotency key', async () => {
    script(resp(200, '{"id":"e1"}'))
    expect(await sendViaResend(env, msg, FAST)).toEqual({ id: 'e1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.headers.Authorization).toBe('Bearer re_test')
    expect(calls[0].init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.parse(calls[0].init.body).text).toBe('h')
  })
  it('retries a 429 and succeeds — a rate-limit burst does not lose the email', async () => {
    script(resp(429, 'slow down'), resp(200, '{"id":"e2"}'))
    expect(await sendViaResend(env, msg, FAST)).toEqual({ id: 'e2' })
    expect(calls).toHaveLength(2)
  })
  it('retries 5xx and network errors', async () => {
    script(resp(503), new Error('socket hang up'), resp(200, '{"id":"e3"}'))
    expect(await sendViaResend(env, msg, FAST)).toEqual({ id: 'e3' })
    expect(calls).toHaveLength(3)
  })
  it('uses the SAME idempotency key on every attempt (a retry can never double-send)', async () => {
    script(resp(500), resp(500), resp(200, '{}'))
    await sendViaResend(env, msg, FAST)
    const keys = new Set(calls.map(c => c.init.headers['Idempotency-Key']))
    expect(keys.size).toBe(1)
  })
  it('does NOT retry a permanent 4xx (bad address / invalid key) — reports it immediately', async () => {
    script(resp(422, '{"message":"invalid to"}'), resp(200))
    await expect(sendViaResend(env, msg, FAST)).rejects.toThrow('422')
    expect(calls).toHaveLength(1)
  })
  it('gives up after the retries are exhausted and throws the last error', async () => {
    script(resp(500, 'a'), resp(502, 'b'), resp(503, 'c'))
    await expect(sendViaResend(env, msg, FAST)).rejects.toThrow('503')
    expect(calls).toHaveLength(3)
  })
  it('omits the text part when none is supplied', async () => {
    script(resp(200))
    await sendViaResend(env, { from: 'a', to: 'b', subject: 's', html: 'h' }, FAST)
    expect(JSON.parse(calls[0].init.body)).not.toHaveProperty('text')
  })
})
