import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import fieldCrypto from '../src/lib/fieldCrypto.js'
import { validateEnv } from '../src/lib/env.js'

// Western placeholders round 5 (carried item): tax IDs are stored sealed, never in clear.
const KEY = Buffer.alloc(32, 5).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 6).toString('base64')
let t
afterEach(() => t?.restore())

describe('fieldCrypto', () => {
  it('seals to enc:v1 and opens back to the same text; every seal is different', async () => {
    const a = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, '123-45-6789')
    const b = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, '123-45-6789')
    expect(a).toMatch(/^enc:v1:/)
    expect(a).not.toContain('6789')
    expect(a).not.toBe(b)
    expect(await fieldCrypto.openTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, a)).toBe('123-45-6789')
  })
  it('without a usable key it refuses to seal (the caller refuses the save) and never returns ciphertext', async () => {
    expect(await fieldCrypto.sealTaxId({}, 'X123')).toBe(null)
    expect(await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: 'not-base64!!' }, 'X123')).toBe(null)
    expect(await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }, 'X123')).toBe(null)
    const sealed = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, 'X123')
    expect(await fieldCrypto.openTaxId({}, sealed)).toBe('')
    expect(await fieldCrypto.openTaxId({ TAX_ID_ENCRYPTION_KEY: OTHER_KEY }, sealed)).toBe('')
  })
  it('reads a legacy plain-text row as it is, and nothing as nothing', async () => {
    expect(await fieldCrypto.openTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, 'A123456789B')).toBe('A123456789B')
    expect(await fieldCrypto.openTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, null)).toBe('')
  })
  it('a sealed value fits the widened database check (3 to 400 characters), a 40-character ID included', async () => {
    const sealed = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, 'x'.repeat(40))
    expect(sealed.length).toBeGreaterThan(40)
    expect(sealed.length).toBeLessThanOrEqual(400)
  })
  it('re-seals only the legacy rows, and only when applied', async () => {
    const rows = [{ id: 'a', tax_id: 'PLAIN-1' }, { id: 'b', tax_id: await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, 'DONE') }, { id: 'c', tax_id: 'PLAIN-2' }]
    const updates = []
    const db = { from: () => { const q = { select: () => q, not: () => q, order: () => q, range: async () => ({ data: rows, error: null }),
      update: patch => ({ eq: async (_c, id) => { updates.push([id, patch.tax_id]); return { error: null } } }) }; return q } }
    expect(await fieldCrypto.sealLegacyTaxIds(db, { TAX_ID_ENCRYPTION_KEY: KEY })).toEqual({ sealed: 2, skipped: 1, applied: false })
    expect(updates).toHaveLength(0)
    expect(await fieldCrypto.sealLegacyTaxIds(db, { TAX_ID_ENCRYPTION_KEY: KEY }, { apply: true })).toMatchObject({ sealed: 2, skipped: 1, applied: true })
    expect(updates.map(u => u[0])).toEqual(['a', 'c'])
    expect(await fieldCrypto.openTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, updates[0][1])).toBe('PLAIN-1')
    await expect(fieldCrypto.sealLegacyTaxIds(db, {}, { apply: true })).rejects.toThrow(/TAX_ID_ENCRYPTION_KEY/)
  })
})

describe('validateEnv', () => {
  it('warns when the key is missing or malformed, and is quiet for a good one', () => {
    expect(validateEnv({}).warnings.join('\n')).toMatch(/TAX_ID_ENCRYPTION_KEY is not set/)
    expect(validateEnv({ TAX_ID_ENCRYPTION_KEY: 'short' }).warnings.join('\n')).toMatch(/not 32 bytes of base64/)
    expect(validateEnv({ TAX_ID_ENCRYPTION_KEY: KEY }).warnings.join('\n')).not.toMatch(/TAX_ID_ENCRYPTION_KEY/)
  })
})

describe('the payout page endpoints', () => {
  function setup(rowTaxId, envKey = KEY) {
    const state = { patch: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'update') return (state.patch = q.patch, { data: { id: 'p1', name: 'Alex', email: 'a@x.co' }, error: null })
      if (q.table === 'partners' && q.op === 'select') return { data: { id: 'p1', name: 'Alex', payout_method: 'BANK', payout_details: { bankName: 'Chase', accountName: 'A', accountNumber: '000123456789' }, tax_country: 'US', tax_id: rowTaxId, payout_details_submitted_at: null, dashboard_token: 'd' }, error: null }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPayoutDetailsChanged: async () => true, sendOwnerAlert: async () => true },
    })
    const c = (body = {}, env = {}) => ({ env: { JWT_SECRET: 'test-link-secret-0123456789abcdef0123', FRONTEND_URL: 'https://usepassthrough.com', ...(envKey ? { TAX_ID_ENCRYPTION_KEY: envKey } : {}), ...env },
      req: { query: () => 'tok123', json: async () => body }, header: () => {}, get: () => ({ id: 'admin-1' }), json: (b, status = 200) => ({ body: b, status }) })
    return { mod, restore, state, c }
  }
  it('saves a tax ID sealed, in a tax-only save and in a full save', async () => {
    t = setup(null)
    await t.mod.submitPayoutDetails(t.c({ taxId: '123-45-6789' }))
    expect(t.state.patch.tax_id).toMatch(/^enc:v1:/)
    t.state.patch = null
    await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'US', routingCode: '021000021', taxId: '123-45-6789' }))
    expect(t.state.patch.tax_id).toMatch(/^enc:v1:/)
    expect(JSON.stringify(t.state.patch)).not.toContain('123-45-6789')
  })
  it('REFUSES to save a tax ID when the server has no key, and writes nothing', async () => {
    t = setup(null, null)
    const a = await t.mod.submitPayoutDetails(t.c({ taxId: '123-45-6789' }))
    expect(a.status).toBe(503)
    expect(a.body).toMatchObject({ success: false, code: 'TAX_STORAGE_UNAVAILABLE' })
    const b = await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'US', routingCode: '021000021', taxId: '123-45-6789' }))
    expect(b.status).toBe(503)
    expect(t.state.patch).toBe(null)
  })
  it('clearing a tax ID needs no key', async () => {
    t = setup('A123456789B', null)
    await t.mod.submitPayoutDetails(t.c({ taxId: '' }))
    expect(t.state.patch.tax_id).toBe(null)
  })
  it('the partner page shows the last four of a sealed ID, and of a legacy plain-text one', async () => {
    const sealed = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, '123-45-6789')
    t = setup(sealed)
    expect((await t.mod.getPartnerByToken(t.c())).body.data.taxIdMasked).toBe('\u20266789')
    t.restore(); t = setup('A123456789B')
    expect((await t.mod.getPartnerByToken(t.c())).body.data.taxIdMasked).toBe('\u2026789B')
  })
  it('the admin reveal returns the whole ID, never the ciphertext', async () => {
    const sealed = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, '123-45-6789')
    t = setup(sealed)
    const res = await t.mod.adminRevealPayoutDetails({ ...t.c(), req: { param: () => '11111111-1111-4111-8111-111111111111' } })
    expect(res.body.data.taxId).toBe('123-45-6789')
  })
})
