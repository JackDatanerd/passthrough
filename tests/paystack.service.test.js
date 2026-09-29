import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initializeTransaction, verifyTransaction, listRefunds, createRefund } from '../src/services/paystack.service.js'

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

describe('listRefunds', () => {
  it('GETs /refund for ONE transaction (reference URL-encoded) with the secret key', async () => {
    mockFetch(200, { status: true, data: [{ status: 'processed', amount: 2900, currency: 'USD' }] })
    const result = await listRefunds(env, 'ref with spaces')
    expect(global.fetch.mock.calls[0][0]).toBe('https://api.paystack.co/refund?reference=ref%20with%20spaces&perPage=50')
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk_test_123')
    expect(result.data[0].amount).toBe(2900)
  })
  it('throws on a non-2xx response (an outage or a bad key is not "no refunds")', async () => {
    mockFetch(401, { status: false, message: 'Invalid key' })
    await expect(listRefunds(env, 'ref-1')).rejects.toThrow('Invalid key')
  })
})

// ── Payments & Pricing pass 1 (B3): the 15s timeout must cover the BODY ──────
// Repro: a server that sends headers and half a JSON body, then stalls. The
// old code cleared its timer as soon as fetch() resolved (headers), so
// res.json() hung forever. Here res.json() only settles by rejecting when the
// request's own abort signal fires, and the 15s timer is fired immediately.
describe('body-read timeout (B3)', () => {
  function stalledBody() {
    global.fetch = vi.fn(async (url, opts) => ({
      ok: true, status: 200,
      json: () => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e) })
      }),
    }))
  }
  function fireTimersNow() {
    const real = global.setTimeout
    vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => real(fn, ms === 15000 ? 0 : ms, ...a))
  }

  it('a stalled verify body fails as a timeout instead of hanging', async () => {
    stalledBody(); fireTimersNow()
    await expect(verifyTransaction(env, 'ref')).rejects.toThrow('Paystack verify timed out after 15s')
  })
  it('a stalled initialize body fails as a timeout', async () => {
    stalledBody(); fireTimersNow()
    await expect(initializeTransaction(env, { email: 'a@b.com', amount: 1, userId: 'u', scanId: 's', fixTier: 'FIX', reference: 'r' }))
      .rejects.toThrow('Paystack initialize timed out after 15s')
  })
  it('a stalled refund-list body fails as a timeout', async () => {
    stalledBody(); fireTimersNow()
    await expect(listRefunds(env, 'ref')).rejects.toThrow('Paystack refund list timed out after 15s')
  })
})

describe('non-JSON responses', () => {
  function htmlBody(status) {
    global.fetch = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => { throw new SyntaxError('Unexpected token <') } }))
  }
  it('an HTML 502 reports the HTTP status, not a SyntaxError', async () => {
    htmlBody(502)
    await expect(verifyTransaction(env, 'r')).rejects.toThrow('Paystack verify returned HTTP 502')
    await expect(initializeTransaction(env, { email: 'a@b.com', amount: 1, userId: 'u', scanId: 's', fixTier: 'FIX', reference: 'r' }))
      .rejects.toThrow('Paystack initialize returned HTTP 502')
  })
  it('a 200 with a non-JSON body is an explicit unreadable-response error (never a fake success)', async () => {
    htmlBody(200)
    await expect(verifyTransaction(env, 'r')).rejects.toThrow('unreadable')
    await expect(listRefunds(env, 'r')).rejects.toThrow('unreadable')
  })
})

describe('createRefund (G1)', () => {
  it('POSTs {transaction} only for a FULL refund and returns the parsed body', async () => {
    mockFetch(200, { status: true, message: 'Refund has been queued for processing', data: { status: 'pending', amount: 2900 } })
    const out = await createRefund(env, 'ref-1', { merchantNote: 'duplicate charge' })
    expect(out.data.status).toBe('pending')
    const [url, opts] = global.fetch.mock.calls[0]
    expect(url).toBe('https://api.paystack.co/refund')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer sk_test_123')
    expect(JSON.parse(opts.body)).toEqual({ transaction: 'ref-1', merchant_note: 'duplicate charge' })
  })
  it('sends amount/currency only when a partial amount is given', async () => {
    mockFetch(200, { status: true, data: {} })
    await createRefund(env, 'ref-1', { amount: 500, currency: 'USD' })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ transaction: 'ref-1', amount: 500, currency: 'USD' })
  })
  it('a 4xx Paystack rejection (already refunded, amount too high) is paystackRejected with its message', async () => {
    mockFetch(400, { status: false, message: 'Transaction has been fully reversed' })
    const err = await createRefund(env, 'r').catch(e => e)
    expect(err.message).toBe('Transaction has been fully reversed')
    expect(err.paystackRejected).toBe(true)
  })
  it('a rejection on a 200 (status:false) is also paystackRejected', async () => {
    mockFetch(200, { status: false, message: 'nope' })
    expect((await createRefund(env, 'r').catch(e => e)).paystackRejected).toBe(true)
  })
  it('auth failures, rate limits and 5xx are NOT rejections — they say nothing about this refund', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      mockFetch(status, { status: false, message: 'x' })
      expect((await createRefund(env, 'r').catch(e => e)).paystackRejected).toBe(false)
    }
  })
})
