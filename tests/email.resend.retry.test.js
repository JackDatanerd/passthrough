import { describe, it, expect, afterEach } from 'vitest'
import { sendViaResend } from '../src/config/email.js'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })
const env = { RESEND_API_KEY: 'k' }
const msg = { from: 'a@b.c', to: 'x@y.z', subject: 's', html: '<p>hi</p>' }

describe('sendViaResend retries', () => {
  it('retries a 409 concurrent_idempotent_requests (our earlier attempt is still in flight) with the SAME idempotency key', async () => {
    const keys = []
    global.fetch = async (url, init) => {
      keys.push(init.headers['Idempotency-Key'])
      return keys.length === 1
        ? new Response('{"name":"concurrent_idempotent_requests","message":"in progress"}', { status: 409 })
        : new Response('{"id":"e1"}', { status: 200 })
    }
    const r = await sendViaResend(env, msg, { retryDelaysMs: [1, 1] })
    expect(r).toEqual({ id: 'e1' })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('does NOT retry an ordinary 409 / 4xx (those are permanent)', async () => {
    let calls = 0
    global.fetch = async () => { calls++; return new Response('{"name":"invalid_idempotent_request"}', { status: 409 }) }
    await expect(sendViaResend(env, msg, { retryDelaysMs: [1, 1] })).rejects.toThrow(/409/)
    expect(calls).toBe(1)
  })

  it('retries a plain rate-limit 429 but NOT an exhausted daily/monthly quota 429', async () => {
    let calls = 0
    global.fetch = async () => { calls++; return calls === 1 ? new Response('{"name":"rate_limit_exceeded"}', { status: 429 }) : new Response('{"id":"e2"}', { status: 200 }) }
    await expect(sendViaResend(env, msg, { retryDelaysMs: [1, 1] })).resolves.toEqual({ id: 'e2' })
    expect(calls).toBe(2)
    calls = 0
    global.fetch = async () => { calls++; return new Response('{"name":"daily_quota_exceeded"}', { status: 429 }) }
    await expect(sendViaResend(env, msg, { retryDelaysMs: [1, 1] })).rejects.toThrow(/429/)
    expect(calls).toBe(1)
  })

  it('a 2xx whose body is not JSON is still a success (the email is already on its way)', async () => {
    global.fetch = async () => new Response('ok', { status: 200 })
    await expect(sendViaResend(env, msg, { retryDelaysMs: [1] })).resolves.toEqual({})
  })
})
