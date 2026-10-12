import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require = createRequire(import.meta.url)
const c = require('../src/config/constants')
const { validateEnv } = require('../src/lib/env')

let realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr })

describe('G1 — price table per currency', () => {
  it('USD (and the default) keep the existing prices, promo included', () => {
    expect(c.priceForTier('FIX', {})).toBe(4900)
    expect(c.priceForTier('BADGE', { PAYSTACK_CURRENCY: 'usd' })).toBe(3900)
    const promo = { PROMO_ACTIVE: 'true', PROMO_ENDS_AT: new Date(Date.now() + 1e6).toISOString() }
    expect(c.priceForTier('BADGE', promo)).toBe(900)
  })
  it('legacy PRICE_* constants still equal the USD table', () => {
    const t = c.PRICES_BY_CURRENCY.USD
    expect([c.PRICE_FIX, c.PRICE_BADGE, c.PRICE_FIX_PLAIN]).toEqual([t.standard.FIX, t.standard.BADGE, t.standard.FIX_PLAIN])
    expect([c.PROMO_PRICE_FIX, c.PROMO_PRICE_BADGE, c.PROMO_PRICE_FIX_PLAIN]).toEqual([t.promo.FIX, t.promo.BADGE, t.promo.FIX_PLAIN])
  })
  it('a currency with no table throws an exposed 503 instead of mis-pricing', () => {
    expect(c.isSupportedCurrency({ PAYSTACK_CURRENCY: 'KES' })).toBe(false)
    let err; try { c.priceForTier('FIX', { PAYSTACK_CURRENCY: 'KES' }) } catch (e) { err = e }
    expect(err.code).toBe('UNSUPPORTED_CURRENCY'); expect(err.status).toBe(503); expect(err.expose).toBe(true)
    expect(() => c.standardPriceForTier('FIX', { PAYSTACK_CURRENCY: 'KES' })).toThrow()
  })
  it('a new currency row is used once added', () => {
    c.PRICES_BY_CURRENCY.KES = { standard: { FIX: 600000, BADGE: 500000, FIX_PLAIN: 500000 }, promo: { FIX: 1, BADGE: 1, FIX_PLAIN: 1 } }
    try { expect(c.priceForTier('FIX', { PAYSTACK_CURRENCY: 'KES' })).toBe(600000) } finally { delete c.PRICES_BY_CURRENCY.KES }
  })
  it('env check warns about an unsupported currency, not about USD', () => {
    expect(validateEnv({ PAYSTACK_CURRENCY: 'KES' }).warnings.join('\n')).toMatch(/no price table/)
    expect(validateEnv({ PAYSTACK_CURRENCY: 'USD' }).warnings.join('\n')).not.toMatch(/no price table/)
  })
  it('initializePayment refuses (503), alerts the owner, and never calls Paystack', async () => {
    const state = { alerts: 0, inits: 0 }
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => createFakeSupabase(() => undefined) },
      'services/email.service.js': { sendOwnerAlert: async () => { state.alerts++ } },
      'services/paystack.service.js': { initializeTransaction: async () => { state.inits++ }, isPendingStatus: () => false },
    })
    try {
      const res = await mod.initializePayment({
        env: { PAYSTACK_CURRENCY: 'KES' }, get: () => ({ id: 'u1', email: 'a@b.co', emailVerified: true }),
        req: { json: async () => ({ scanId: '11111111-1111-1111-1111-111111111111', fixTier: 'FIX' }) },
        json: (b, s = 200) => ({ body: b, status: s }),
      })
      expect(res.status).toBe(503); expect(state.alerts).toBe(1); expect(state.inits).toBe(0)
    } finally { restore() }
  })
})

describe('B1 — verify on a DISPUTED / REFUNDED row', () => {
  async function verify(status, paystackStatus = 'success') {
    const row = { id: 'p1', paystack_ref: 'ref-1', user_id: 'u1', scan_id: 's1', status, amount_cents: 4900, currency: 'USD', fix_tier: 'FIX' }
    const db = createFakeSupabase(q => {
      if (q.table === 'payments' && q.op === 'select') return { data: row, error: null }
      if (q.table === 'payments' && q.op === 'update') return { data: [], error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {} },
      'services/paystack.service.js': {
        verifyTransaction: async () => ({ data: { status: paystackStatus, amount: 4900, currency: 'USD' } }),
        isPendingStatus: () => false,
      },
    })
    try {
      return await mod.verifyPayment({ env: {}, get: () => ({ id: 'u1' }),
        req: { query: k => (k === 'reference' ? 'ref-1' : undefined) }, json: (b, s = 200) => ({ body: b, status: s }) })
    } finally { restore() }
  }
  it('DISPUTED: success with disputed:true, not "nothing was delivered"', async () => {
    const res = await verify('DISPUTED')
    expect(res.status).toBe(200); expect(res.body.success).toBe(true)
    expect(res.body.data).toEqual({ scanId: 's1', disputed: true })
  })
  it('REFUNDED + Paystack success: refunded:true', async () => {
    const res = await verify('REFUNDED')
    expect(res.status).toBe(200); expect(res.body.data).toEqual({ scanId: 's1', refunded: true })
  })
  it('REFUNDED + Paystack reversed: refunded:true, not a 400 "reversed, nothing delivered"', async () => {
    const res = await verify('REFUNDED', 'reversed')
    expect(res.status).toBe(200); expect(res.body.data.refunded).toBe(true)
  })
  it('a never-settled PENDING row reported reversed is still a decline', async () => {
    expect((await verify('PENDING', 'reversed')).status).toBe(400)
  })
})
