import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initializeTransaction, verifyTransaction } from '../src/services/paystack.service.js'

// paystack.service.js was previously the one payment-facing module with zero
// direct test coverage — payments.controller.test.js stubs it out entirely
// via loadWithStubs, so its own fetch/parsing/error logic (including the
// res.ok-vs-json.status distinction documented in verifyTransaction) was
// never actually exercised by any test. This drives the real functions
// against a mocked global fetch instead of a stub.

const env = { PAYSTACK_SECRET_KEY: 'sk_test_123', PAYSTACK_CALLBACK_URL: 'https://passthrough.dev/cb' }

function mockFetch(status, json) {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  }))
}

beforeEach(() => { global.fetch = undefined })
afterEach(() => { vi.restoreAllMocks() })

describe('initializeTransaction', () => {
  it('posts to Paystack with the expected body and returns the authorization payload', async () => {
    mockFetch(200, { status: true, data: { authorization_url: 'https://paystack.test/pay/AC_1', access_code: 'AC_1' } })

    const result = await initializeTransaction(env, {
      email: 'a@b.com', amount: 2900, userId: 'u1', scanId: 's1', fixTier: 'FIX', reference: 'ref-1'
    })

    expect(result).toEqual({ authorization_url: 'https://paystack.test/pay/AC_1', access_code: 'AC_1', reference: 'ref-1' })
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.paystack.co/transaction/initialize')
    expect(opts.headers.Authorization).toBe('Bearer sk_test_123')
    const body = JSON.parse(opts.body)
    expect(body).toMatchObject({
      email: 'a@b.com', amount: 2900, currency: 'USD', reference: 'ref-1',
      callback_url: 'https://passthrough.dev/cb',
      metadata: { userId: 'u1', scanId: 's1', fixTier: 'FIX', custom_fields: [] },
    })
  })

  it('honours env.PAYSTACK_CURRENCY over the default', async () => {
    mockFetch(200, { status: true, data: { authorization_url: 'x', access_code: 'y' } })
    await initializeTransaction({ ...env, PAYSTACK_CURRENCY: 'KES' },
      { email: 'a@b.com', amount: 100, userId: 'u', scanId: 's', fixTier: 'FIX', reference: 'r' })
    const body = JSON.parse(global.fetch.mock.calls[0][1].body)
    expect(body.currency).toBe('KES')
  })

  it('throws when Paystack reports status:false, using its message', async () => {
    mockFetch(200, { status: false, message: 'Invalid key' })
    await expect(initializeTransaction(env, {
      email: 'a@b.com', amount: 2900, userId: 'u1', scanId: 's1', fixTier: 'FIX', reference: 'ref-1'
    })).rejects.toThrow('Invalid key')
  })

  it('throws a generic message when Paystack gives status:false with no message', async () => {
    mockFetch(200, { status: false })
    await expect(initializeTransaction(env, {
      email: 'a@b.com', amount: 2900, userId: 'u1', scanId: 's1', fixTier: 'FIX', reference: 'ref-1'
    })).rejects.toThrow('Paystack init failed')
  })
})

describe('verifyTransaction', () => {
  it('GETs the verify endpoint with the reference URL-encoded and returns the parsed body', async () => {
    mockFetch(200, { status: true, data: { status: 'success', amount: 2900, currency: 'USD' } })
    const result = await verifyTransaction(env, 'ref with spaces')
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.paystack.co/transaction/verify/ref%20with%20spaces')
    expect(result.data.status).toBe('success')
  })

  // This is the exact case the module's own comment calls out: an ordinary
  // declined/failed transaction still comes back as a normal 200 with
  // json.status: false — that must NOT throw, it's the caller's job (via
  // data.status !== 'success') to treat it as a failed payment, not a
  // system fault worth a [CRITICAL] alert.
  it('does NOT throw on an ordinary failed transaction (200, json.status:false)', async () => {
    mockFetch(200, { status: false, data: { status: 'failed' } })
    const result = await verifyTransaction(env, 'ref-1')
    expect(result.data.status).toBe('failed')
  })

  // The actual bugfix under test: a non-2xx HTTP response (rotated key, an
  // outage) must throw, so it surfaces as an operational failure rather than
  // silently falling through to the same "payment didn't succeed" path.
  it('throws on a non-2xx HTTP response, using the body message', async () => {
    mockFetch(401, { message: 'Invalid key' })
    await expect(verifyTransaction(env, 'ref-1')).rejects.toThrow('Invalid key')
  })

  it('throws a generic message on a non-2xx response with no body message', async () => {
    mockFetch(500, {})
    await expect(verifyTransaction(env, 'ref-1')).rejects.toThrow('Paystack verify returned HTTP 500')
  })
})
