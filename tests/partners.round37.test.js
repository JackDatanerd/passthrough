import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 37: controller-level coverage of the payout rails added in the "Western placeholders" commit (PayPal, US/UK/AU/CA routing,
// IBAN, SWIFT), plus the canonical storage of routing / SWIFT values and the terms-version bump.

let t
afterEach(() => t?.restore())
const REAL = '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11'
const ENV = { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'j'.repeat(40), PAYSTACK_CURRENCY: 'USD' }
const ctxOf = (body, over = {}) => ({
  env: { ...ENV, ...(over.env || {}) }, get: () => ({ id: 'admin-1' }),
  req: { param: k => (over.params || {})[k] ?? REAL, query: () => undefined, json: async () => body ?? {}, header: k => (k === 'x-partner-token' ? 'tok' : undefined) },
  header: () => {}, json: (b, s = 200) => ({ body: b, status: s }), executionCtx: { waitUntil: () => {} },
})
const BANK = { bankName: 'Chase', accountName: 'Jo Smith', accountNumber: '123456789012', bankCountry: 'US', routingCode: '021000021' }
const base = over => ({ id: REAL, name: 'P', email: 'p@x.co', payout_method: null, payout_details: null, payout_details_submitted_at: null, tax_country: null, tax_id: null, ...over })
// Runs submitPayoutDetails against a stored partner row; returns the response and every partners update.
const submit = async (prev, body, email = {}) => {
  const updates = [], alerts = []
  const db = createFakeSupabase(q => q.table === 'partners'
    ? (q.op === 'update' ? (updates.push(q.patch), { data: base(prev), error: null }) : { data: base(prev), error: null }) : undefined)
  t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async a => { alerts.push(a) }, sendPayoutDetailsChanged: async () => true, ...email } })
  const res = await t.mod.submitPayoutDetails(ctxOf(body))
  t.restore()
  return { res, updates, alerts }
}

describe('submitting payout details on the new rails', () => {
  it('stores PayPal details, with a hold, and a case-only change to the email is rewritten quietly', async () => {
    const first = await submit({}, { payoutMethod: 'PAYPAL', accountName: 'Jo', paypalEmail: 'Jo@X.com' })
    expect(first.updates[0]).toMatchObject({ payout_method: 'PAYPAL', payout_details: { accountName: 'Jo', paypalEmail: 'Jo@X.com' } })
    expect(first.updates[0].payout_details_submitted_at).toBeTruthy()
    const prev = { payout_method: 'PAYPAL', payout_details: { accountName: 'Jo', paypalEmail: 'jo@x.com' }, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
    const cosmetic = await submit(prev, { payoutMethod: 'PAYPAL', accountName: 'Jo', paypalEmail: 'Jo@X.com' })
    expect(cosmetic.updates).toHaveLength(1)
    expect(cosmetic.updates[0]).not.toHaveProperty('payout_details_submitted_at')
    expect(cosmetic.res.body.unchanged).toBe(false)
  })
  it('refuses a US account with a routing number that fails the ABA checksum', async () => {
    await expect(submit({}, { payoutMethod: 'BANK', ...BANK, routingCode: '123456789' })).rejects.toThrow(/routing number/i)
  })
  it('re-saving identical bank details changes nothing', async () => {
    const prev = { payout_method: 'BANK', payout_details: BANK, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
    const r = await submit(prev, { payoutMethod: 'BANK', ...BANK })
    expect(r.updates).toHaveLength(0)
    expect(r.res.body.unchanged).toBe(true)
  })
  it('changing only the routing code is a destination change: payout hold restarts and the owner is alerted', async () => {
    const prev = { payout_method: 'BANK', payout_details: BANK, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
    const r = await submit(prev, { payoutMethod: 'BANK', ...BANK, routingCode: '011401533' })
    expect(r.updates[0].payout_details_submitted_at).not.toBe('2026-01-01T00:00:00Z')
    expect(r.updates[0].payout_details.routingCode).toBe('011401533')
  })
  it('a legacy bank account adding its country and SWIFT also restarts the hold (a routing code on an identical number could redirect the money)', async () => {
    const legacy = { bankName: 'Equity', accountName: 'Jo', accountNumber: '0123456789' }
    const prev = { payout_method: 'BANK', payout_details: legacy, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
    const r = await submit(prev, { payoutMethod: 'BANK', ...legacy, bankCountry: 'KE', swiftBic: 'EQBLKENA' })
    expect(r.updates[0].payout_details_submitted_at).not.toBe('2026-01-01T00:00:00Z')
  })
})

describe('canonical storage of routing and SWIFT values', () => {
  it('stores SWIFT upper-case without spaces and a routing code without spaces', async () => {
    const r = await submit({}, { payoutMethod: 'BANK', bankName: 'DBS', accountName: 'Jo', accountNumber: '1234567890', bankCountry: 'sg', swiftBic: 'dbss sgsg' })
    expect(r.updates[0].payout_details).toEqual({ bankName: 'DBS', accountName: 'Jo', accountNumber: '1234567890', bankCountry: 'SG', swiftBic: 'DBSSSGSG' })
    const gb = await submit({}, { payoutMethod: 'BANK', bankName: 'Barclays', accountName: 'Jo', accountNumber: '55779911', bankCountry: 'GB', routingCode: '20 00 00' })
    expect(gb.updates[0].payout_details.routingCode).toBe('200000')
  })
  it('drops an optional key that arrives empty instead of storing an empty string', async () => {
    const r = await submit({}, { payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Jo', accountNumber: 'DE89 3704 0044 0532 0130 00', bankCountry: 'DE', routingCode: '', swiftBic: '' })
    expect(r.updates[0].payout_details).not.toHaveProperty('routingCode')
    expect(r.updates[0].payout_details).not.toHaveProperty('swiftBic')
  })
  it('an old value stored loosely is rewritten to the canonical form when the same details are saved again (no hold)', async () => {
    const loose = { bankName: 'DBS', accountName: 'Jo', accountNumber: '1234567890', bankCountry: 'SG', swiftBic: 'dbss sgsg' }
    const prev = { payout_method: 'BANK', payout_details: loose, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
    const r = await submit(prev, { payoutMethod: 'BANK', ...loose, swiftBic: 'DBSSSGSG' })
    expect(r.updates).toHaveLength(1)
    expect(r.updates[0].payout_details.swiftBic).toBe('DBSSSGSG')
    expect(r.updates[0]).not.toHaveProperty('payout_details_submitted_at')
  })
})

describe('reading and erasing the new details', () => {
  const load = db => (t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {} } }))
  it('the partner page masks the PayPal email and the account number but shows the routing details', async () => {
    const pp = createFakeSupabase(q => q.table === 'partners' ? { data: base({ payout_method: 'PAYPAL', payout_details: { accountName: 'Jo', paypalEmail: 'john.doe@gmail.com' }, payout_details_submitted_at: '2026-01-01T00:00:00Z' }), error: null } : undefined)
    const a = await load(pp).mod.getPartnerByToken(ctxOf())
    expect(a.body.data.payoutDetails).toEqual({ accountName: 'Jo', paypalEmail: 'j***@gmail.com' })
    t.restore()
    const bk = createFakeSupabase(q => q.table === 'partners' ? { data: base({ payout_method: 'BANK', payout_details: BANK, payout_details_submitted_at: '2026-01-01T00:00:00Z' }), error: null } : undefined)
    const b = await load(bk).mod.getPartnerByToken(ctxOf())
    expect(b.body.data.payoutDetails).toMatchObject({ bankName: 'Chase', bankCountry: 'US', routingCode: '021000021' })
    expect(b.body.data.payoutDetails.accountNumber).toMatch(/9012$/)
    expect(b.body.data.payoutDetails.accountNumber).not.toContain('12345678')
  })
  it('erasing a partner wipes the PayPal address from every payout snapshot', async () => {
    const snaps = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { id: REAL, email: 'p@x.co', previous_emails: [], dashboard_token_version: 0 }, error: null }
      if (q.table === 'payouts' && q.op === 'select') return { data: [{ id: 'po1', payout_method: 'PAYPAL', payout_details_snapshot: { accountName: 'Jo', paypalEmail: 'jo@x.com' } }], error: null }
      if (q.table === 'payouts' && q.op === 'update') { snaps.push(q.patch.payout_details_snapshot); return { data: null, error: null } }
      return undefined
    })
    await load(db).mod.adminAnonymizePartner(ctxOf({ reason: 'partner asked to be removed' }))
    expect(snaps).toEqual([{ accountName: 'Removed', paypalEmail: '' }])
  })
})

describe('recording and exporting payouts for PayPal', () => {
  const load = db => (t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {} } }))
  const old = new Date(Date.now() - 90 * 86400000).toISOString()
  const partner = { id: REAL, name: 'P', email: 'p@x.co', status: 'ACTIVE', payout_method: 'PAYPAL', payout_details: { accountName: 'Jo', paypalEmail: 'jo@x.com' }, payout_details_submitted_at: '2026-01-01T00:00:00Z' }
  const ledger = [{ id: 'l1', partner_id: REAL, commission_amount_cents: 5000, reverses_ledger_id: null, kind: 'SALE', currency: 'USD', created_at: old, payments: { status: 'SUCCESS' } }]
  it('the payout-run export carries the PayPal address and method', async () => {
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: [partner], error: null } : q.table === 'commission_ledger' ? { data: ledger, error: null } : { data: [], error: null })
    const res = await load(db).mod.adminPayoutRunExport(ctxOf())
    expect(res.body.data[0]).toMatchObject({ payoutMethod: 'PAYPAL', payoutDetails: { paypalEmail: 'jo@x.com' }, readyToPayCents: 5000, currency: 'USD' })
  })
  it('recording a payout by a different method than the one on file is refused in plain words', async () => {
    const db = createFakeSupabase(q => q.table === 'partners' ? { data: partner, error: null } : q.table === 'commission_ledger' ? { data: ledger, error: null } : { data: [], error: null })
    const res = await load(db).mod.adminRecordPayout(ctxOf({ payoutMethod: 'BANK', amountCents: 5000 }))
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/PayPal/i)
    expect(res.body.message).toMatch(/bank/i)
  })
})

describe('terms version', () => {
  it('is the bumped one, so partners who accepted the old text are asked and told', async () => {
    const db = createFakeSupabase()
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {} } })
    const res = await t.mod.getProgramTerms(ctxOf())
    expect(res.body.data.termsVersion).toBe('2026-10b')
  })
})
