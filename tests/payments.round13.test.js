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

async function verify(status, paystackStatus, { amountRow = 4900, amountPs = 4900 } = {}) {
  const row = { id: 'p1', paystack_ref: 'ref-1', user_id: 'u1', scan_id: 's1', status, amount_cents: amountRow, currency: 'USD', fix_tier: 'FIX' }
  const alerts = []
  const db = createFakeSupabase(q => {
    if (q.table === 'payments' && q.op === 'select') return { data: row, error: null }
    if (q.table === 'payments' && q.op === 'update') return { data: [], error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/payments.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (_e, s) => { alerts.push(s) } },
    'services/paystack.service.js': {
      verifyTransaction: async () => ({ data: { status: paystackStatus, amount: amountPs, currency: 'USD' } }),
      isPendingStatus: () => false,
    },
  })
  try {
    const res = await mod.verifyPayment({ env: {}, get: () => ({ id: 'u1' }),
      req: { query: k => (k === 'reference' ? 'ref-1' : undefined) }, json: (b, s = 200) => ({ body: b, status: s }) })
    return { res, alerts }
  } finally { restore() }
}

describe('round 13 — verify on settled DISPUTED / REFUNDED rows', () => {
  it('DISPUTED + Paystack reversed: delivered + disputed, not a 400 decline', async () => {
    const { res } = await verify('DISPUTED', 'reversed')
    expect(res.status).toBe(200); expect(res.body.data).toEqual({ scanId: 's1', disputed: true })
  })
  it('a never-settled PENDING row reported reversed is still a decline', async () => {
    expect((await verify('PENDING', 'reversed')).res.status).toBe(400)
  })
  for (const st of ['DISPUTED', 'REFUNDED']) {
    it(`${st} row with an accepted overpayment: no mismatch hold, no alert`, async () => {
      const { res, alerts } = await verify(st, 'success', { amountPs: 5100 })
      expect(res.status).toBe(200); expect(alerts).toEqual([])
    })
  }
  it('an unsettled PENDING row with a different amount is still held', async () => {
    const { res, alerts } = await verify('PENDING', 'success', { amountPs: 5100 })
    expect(res.status).toBe(409); expect(alerts.length).toBe(1)
  })
})

describe('round 13 — one canonical currency', () => {
  it('activeCurrency trims and upper-cases; every consumer uses it', () => {
    expect(c.activeCurrency({ PAYSTACK_CURRENCY: ' usd ' })).toBe('USD')
    const fs = require('fs'), path = require('path')
    for (const f of ['controllers/pricing.controller.js', 'controllers/payments.controller.js', 'controllers/scan.controller.js', 'controllers/partners.controller.js', 'services/email.service.js', 'services/referral.service.js', 'services/paystack.service.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
      expect(src, f).not.toMatch(/PAYSTACK_CURRENCY\s*\|\|\s*c\.CURRENCY/)
    }
  })
  it('the quote reports the canonical currency for a lowercase env value', async () => {
    const { mod, restore } = loadWithStubs('controllers/pricing.controller.js', {})
    try {
      const res = await mod.getPricing({ env: { PAYSTACK_CURRENCY: ' usd ' }, get: () => undefined,
        req: { query: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }) })
      expect(res.body.data.currency).toBe('USD')
    } finally { restore() }
  })
  it('env check flags a non-canonical value, not the canonical one', () => {
    expect(validateEnv({ PAYSTACK_CURRENCY: 'usd' }).warnings.join('\n')).toMatch(/canonical/)
    expect(validateEnv({ PAYSTACK_CURRENCY: 'USD' }).warnings.join('\n')).not.toMatch(/canonical/)
  })
})
