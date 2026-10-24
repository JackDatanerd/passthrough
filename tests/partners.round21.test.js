import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 fresh pass: erasure clears tax details, tax-only saves, void notice skips erased partners,
// and a late conversion never lands on an erased partner.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://x.test', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', TAX_ID_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64') },
  get: () => ({ id: 'admin-1' }),
  req: {
    param: n => (over.params ? over.params[n] : 'p1'), query: () => undefined,
    json: async () => over.body ?? {},
    header: n => (String(n).toLowerCase() === 'x-partner-token' ? over.token : undefined),
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(resolver, email = {}) {
  const db = createFakeSupabase(resolver)
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async () => true, ...email },
  })
  return { ...m, db }
}

describe('erasure clears tax details', () => {
  it('nulls tax_country and tax_id on the partner row', async () => {
    let patch = null
    t = load(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { id: 'p1', email: 'k@x.co' }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: [], error: null }
      if (q.table === 'partners' && q.op === 'update') { patch = q.patch; return { data: null, error: null } }
      if (q.table === 'payouts' && q.op === 'select') return { data: [], error: null }
      return { data: [], error: null }
    })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'erasure request' } }))
    expect(res.status).toBe(200)
    expect(patch).toMatchObject({ tax_country: null, tax_id: null })
  })
})

describe('tax-only save on the payout-details link', () => {
  it('updates only the tax fields and leaves the payout destination alone', async () => {
    let patch = null
    t = load(q => {
      if (q.table === 'partners' && q.op === 'update') { patch = q.patch; return { data: { id: 'p1' }, error: null } }
      return { data: null, error: null }
    })
    const res = await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: { taxCountry: 'ke', taxId: '' } }))
    expect(res.status).toBe(200)
    expect(patch).toMatchObject({ tax_country: 'KE', tax_id: null })
    expect(patch).not.toHaveProperty('payout_method')
    expect(patch).not.toHaveProperty('payout_details_submitted_at')
  })
  it('404s on an unknown link and rejects an empty body or a bad country', async () => {
    t = load(q => (q.op === 'update' ? { data: null, error: null } : undefined))
    expect((await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: { taxId: 'A1234567' } }))).status).toBe(404)
    expect((await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: {} }))).status).toBe(400)
    await expect(t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: { taxCountry: 'KEN' } }))).rejects.toThrow()
  })
})

describe('voiding a payout for an erased partner', () => {
  it('records the void but sends no email to the placeholder address', async () => {
    let sent = 0
    t = load(q => {
      if (q.table === 'payouts' && q.op === 'select') return { data: { id: 'po1', partner_id: 'p1', amount_cents: 500, currency: 'USD', voided_at: null }, error: null }
      if (q.op === 'rpc') return { data: { already_voided: false, released: 1 }, error: null }
      if (q.table === 'partners' && q.op === 'select') return { data: { name: 'Removed partner', email: 'partner-p1@removed.invalid' }, error: null }
      return { data: null, error: null }
    }, { sendPartnerPayoutVoided: async () => { sent++; return true } })
    const res = await t.mod.adminVoidPayout(ctxOf({ params: { id: 'p1', payoutId: 'po1' }, body: { reason: 'wrong account' } }))
    expect(res.status).toBe(200)
    expect(sent).toBe(0)
  })
})

describe('a late conversion for an erased partner', () => {
  it('records no commission and frees the reserved slot', async () => {
    const released = []
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes' && q.op === 'select') return { data: { id: 'rc1', partner_id: 'p1', code: 'REMOVED-AB12CD34' }, error: null }
      if (q.table === 'partners' && q.op === 'select') return { data: { name: 'Removed partner', email: 'partner-p1@removed.invalid', commission_rate: 0.25 }, error: null }
      if (q.op === 'rpc' && q.fn === 'release_referral_code_slot') released.push(q.args)
      return { data: null, error: null }
    })
    const svc = require('../src/services/referral.service.js')
    const out = await svc.recordConversion(db, { id: 'pay1', referral_code_id: 'rc1', amount_cents: 5000, referral_reservation_id: 'res1' }, undefined)
    expect(out).toMatchObject({ ok: true, recorded: false, reason: 'partner-removed' })
    expect(db.calls.some(c => c.table === 'commission_ledger' && c.op === 'insert')).toBe(false)
  })
})
