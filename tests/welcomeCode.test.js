import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const c = require('../src/config/constants.js')
const welcome = require('../src/services/welcomeCode.service.js')
const referral = require('../src/services/referral.service.js')

// Welcome codes (migration 0105): one personal, single-use code on the full fix per verified account, owned by the 0%
// system partner, priced for that account only.

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0)              // 25 Oct 2026
const DAY = 24 * 60 * 60 * 1000
const iso = ms => new Date(ms).toISOString()
// Standard prices only: $49 full fix -> 30% off = $34.30.
const STANDARD = { PAYSTACK_CURRENCY: 'USD' }
// Promo on until `daysLeft` days from NOW: $29 full fix -> 30% off = $20.30.
const promoEnv = daysLeft => ({ PAYSTACK_CURRENCY: 'USD', PROMO_ACTIVE: 'true', PROMO_ENDS_AT: iso(NOW + daysLeft * DAY) })
const USER = { id: 'u1', name: 'Faith Nelson', email: 'faith@example.com' }

afterEach(() => vi.useRealTimers())
const freezeTime = () => vi.useFakeTimers({ toFake: ['Date'], now: NOW })

describe('code format', () => {
  it('takes initials from the name, never the name itself', () => {
    expect(welcome.initialsOf('Faith Nelson')).toBe('FN')
    expect(welcome.initialsOf('Cher')).toBe('C')
    expect(welcome.initialsOf("  mary-jane o'neil ")).toBe('MO')
    expect(welcome.initialsOf('Émile Zola')).toBe('EZ')
    expect(welcome.initialsOf('Ana Maria de la Cruz')).toBe('AC')
  })
  it('has no initials when the name has no Latin letters, and falls back to PT', () => {
    expect(welcome.initialsOf('李雷')).toBe('')
    expect(welcome.initialsOf('')).toBe('')
    expect(welcome.initialsOf(null)).toBe('')
    expect(welcome.generateCode('李雷')).toMatch(/^PT-[A-Z2-9]{5}$/)
  })
  it('is initials, a dash and five unambiguous characters (no 0, O, 1 or I in the random part)', () => {
    const seen = new Set()
    for (let i = 0; i < 400; i++) {
      const code = welcome.generateCode('Faith Nelson')
      expect(code).toMatch(/^FN-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/)
      seen.add(code)
    }
    expect(seen.size).toBeGreaterThan(395)             // 32^5 combinations: collisions are rare, not impossible
  })
  it('satisfies the database rule that a code is stored in capitals', () => {
    const code = welcome.generateCode('faith njeri')
    expect(code).toBe(code.toUpperCase())
  })
})

describe('price and expiry', () => {
  it('prices 30% off the price in force right now: the promo price during the promo', () => {
    freezeTime()
    expect(welcome.welcomePriceCents(promoEnv(30))).toEqual({ base: 2900, cents: 2030 })
  })
  it('and off the standard price when there is no promo', () => {
    expect(welcome.welcomePriceCents(STANDARD)).toEqual({ base: 4900, cents: 3430 })
  })
  it('lasts 14 days', () => {
    freezeTime()
    expect(welcome.expiryFor(STANDARD, NOW)).toBe(NOW + 14 * DAY)
    expect(welcome.expiryFor(promoEnv(30), NOW)).toBe(NOW + 14 * DAY)
  })
  it('is a fixed 14 days whatever the promo does: the percentage is worked out when the code is used, so there is nothing to outlive', () => {
    freezeTime()
    expect(welcome.expiryFor(promoEnv(5), NOW)).toBe(NOW + 14 * DAY)
    expect(welcome.expiryFor(promoEnv(0.5), NOW)).toBe(NOW + 14 * DAY)
  })
  it('is always the stated percentage of the price in force (constants.welcomeAmountFor)', () => {
    expect(c.welcomeAmountFor(2900)).toBe(2030)
    expect(c.welcomeAmountFor(4900)).toBe(3430)
  })
})

// A fake referral_codes table: remembers inserted rows and answers lookups by user_id.
function codesDb({ rows = [], insertErrors = [], selectError = null } = {}) {
  const state = { inserts: [], rows: [...rows], insertCalls: 0 }
  const db = createFakeSupabase(q => {
    if (q.table !== 'referral_codes') return undefined
    if (q.op === 'select') {
      if (selectError) return { data: null, error: selectError }
      const byUser = q.filters.find(f => f[1] === 'user_id')
      return { data: state.rows.find(r => r.user_id === byUser?.[2]) ?? null, error: null }
    }
    if (q.op === 'insert') {
      const err = insertErrors[state.insertCalls++]
      if (err) return { data: null, error: err }
      state.inserts.push(q.values)
      state.rows.push({ ...q.values, uses_so_far: 0, partners: { status: 'ACTIVE' } })
      return { data: null, error: null }
    }
  })
  return { db, state }
}

describe('issueWelcomeCode', () => {
  it('writes one personal, single-use, expiring code owned by the system partner, and returns the offer', async () => {
    freezeTime()
    const { db, state } = codesDb()
    const res = await welcome.issueWelcomeCode(db, promoEnv(30), USER, NOW)
    expect(res.issued).toBe(true)
    expect(state.inserts).toHaveLength(1)
    const row = state.inserts[0]
    expect(row).toMatchObject({
      partner_id: c.WELCOME_PARTNER_ID, tier_prices: { FIX: 2030 }, active: true, usage_limit: 1, user_id: 'u1',
      expires_at: iso(NOW + 14 * DAY),
    })
    expect(row.code).toMatch(/^FN-[A-Z2-9]{5}$/)
    expect(res.offer).toMatchObject({ code: row.code, tier: 'FIX', amountCents: 2030, listAmountCents: 2900, percentOff: 30, currency: 'USD' })
  })

  it('is idempotent: an account that already has a code gets it back, and nothing is written', async () => {
    freezeTime()
    const existing = { user_id: 'u1', code: 'FN-AAAAA', tier_prices: { FIX: 2030 }, active: true, usage_limit: 1, uses_so_far: 0, expires_at: iso(NOW + 3 * DAY), partners: { status: 'ACTIVE' } }
    const { db, state } = codesDb({ rows: [existing] })
    const res = await welcome.issueWelcomeCode(db, promoEnv(30), USER, NOW)
    expect(res).toMatchObject({ issued: false, reason: 'exists' })
    expect(res.offer.code).toBe('FN-AAAAA')
    expect(state.inserts).toEqual([])
  })

  it('issues a code even in the last day of a promo (nothing about it depends on the promo any more)', async () => {
    freezeTime()
    const { db, state } = codesDb()
    const res = await welcome.issueWelcomeCode(db, promoEnv(0.5), USER, NOW)
    expect(res.issued).toBe(true)
    expect(state.inserts[0].expires_at).toBe(iso(NOW + 14 * DAY))
  })

  it('tries again with a new code when the random one is already taken', async () => {
    freezeTime()
    const { db, state } = codesDb({ insertErrors: [{ code: '23505', message: 'duplicate key value violates unique constraint "referral_codes_code_key"' }] })
    const res = await welcome.issueWelcomeCode(db, STANDARD, USER, NOW)
    expect(res.issued).toBe(true)
    expect(state.insertCalls).toBe(2)
    expect(state.inserts).toHaveLength(1)
  })

  it('gives up with an error if it cannot find an unused code (it should never happen)', async () => {
    const dup = { code: '23505', message: 'duplicate key' }
    const { db, state } = codesDb({ insertErrors: [dup, dup, dup, dup, dup] })
    await expect(welcome.issueWelcomeCode(db, STANDARD, USER, NOW)).rejects.toThrow(/unused code/)
    expect(state.insertCalls).toBe(5)
  })

  it('treats losing a race with another request as "already has one"', async () => {
    freezeTime()
    // The first lookup finds nothing; the insert then collides because the other request just wrote this account's code.
    const mine = { user_id: 'u1', code: 'FN-WINNR', tier_prices: { FIX: 3430 }, active: true, usage_limit: 1, uses_so_far: 0, expires_at: iso(NOW + 10 * DAY), partners: { status: 'ACTIVE' } }
    let lookups = 0
    const db = createFakeSupabase(q => {
      if (q.op === 'select') return { data: ++lookups === 1 ? null : mine, error: null }
      if (q.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "referral_codes_one_per_user_uidx"' } }
    })
    const res = await welcome.issueWelcomeCode(db, STANDARD, USER, NOW)
    expect(res).toMatchObject({ issued: false, reason: 'exists' })
  })

  it('reports (never throws) when migration 0105 has not been applied', async () => {
    const missing = { code: '42703', message: 'column referral_codes.user_id does not exist' }
    expect(await welcome.issueWelcomeCode(codesDb({ selectError: missing }).db, STANDARD, USER, NOW)).toEqual({ issued: false, reason: 'migration' })
    expect(await welcome.issueWelcomeCode(codesDb({ selectError: { code: 'PGRST204', message: "Could not find the 'user_id' column of 'referral_codes'" } }).db, STANDARD, USER, NOW)).toEqual({ issued: false, reason: 'migration' })
  })

  it('reports when the system partner row is missing (foreign key)', async () => {
    const { db } = codesDb({ insertErrors: [{ code: '23503', message: 'violates foreign key constraint' }] })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await welcome.issueWelcomeCode(db, STANDARD, USER, NOW)).toEqual({ issued: false, reason: 'no-system-partner' })
    spy.mockRestore()
  })

  it('throws a genuine database error for the caller to log', async () => {
    const { db } = codesDb({ insertErrors: [{ code: '57014', message: 'canceling statement due to statement timeout' }] })
    await expect(welcome.issueWelcomeCode(db, STANDARD, USER, NOW)).rejects.toMatchObject({ code: '57014' })
  })
})

describe('getWelcomeOffer', () => {
  const row = over => ({ user_id: 'u1', code: 'FN-AAAAA', tier_prices: { FIX: 2030 }, active: true, usage_limit: 1, uses_so_far: 0, expires_at: iso(NOW + 5 * DAY), partners: { status: 'ACTIVE' }, ...over })
  const offer = async over => { freezeTime(); return welcome.getWelcomeOffer(codesDb({ rows: [row(over)] }).db, promoEnv(30), 'u1', NOW) }

  it('returns a usable code as an offer, with the percentage worked out from today\'s price', async () => {
    expect(await offer()).toMatchObject({ code: 'FN-AAAAA', tier: 'FIX', amountCents: 2030, listAmountCents: 2900, percentOff: 30, expiresAt: iso(NOW + 5 * DAY) })
  })
  it('returns null when the account has no code', async () => {
    freezeTime()
    expect(await welcome.getWelcomeOffer(codesDb().db, promoEnv(30), 'u1', NOW)).toBeNull()
  })
  it('returns null once the code is used, expired, switched off, or its partner is paused', async () => {
    expect(await offer({ uses_so_far: 1 })).toBeNull()
    expect(await offer({ expires_at: iso(NOW - 1000) })).toBeNull()
    expect(await offer({ active: false })).toBeNull()
    expect(await offer({ partners: { status: 'PAUSED' } })).toBeNull()
  })
  it("quotes the percentage off TODAY's price, not the cents the code was issued with", async () => {
    freezeTime()
    // Issued during the promo ($29 -> 2030); the promo has since ended, so today's full fix is $49 and the code is 30% off that.
    const after = await welcome.getWelcomeOffer(codesDb({ rows: [row()] }).db, STANDARD, 'u1', NOW)
    expect(after).toMatchObject({ amountCents: 3430, listAmountCents: 4900, percentOff: 30 })
  })
  it('returns null for a code that does not price the full fix at all', async () => {
    expect(await offer({ tier_prices: {} })).toBeNull()
    expect(await offer({ tier_prices: { BADGE: 450 } })).toBeNull()
  })
  it('returns null (not an error) before migration 0105 is applied, and rethrows anything else', async () => {
    freezeTime()
    const late = codesDb({ selectError: { code: '42703', message: 'column referral_codes.user_id does not exist' } }).db
    expect(await welcome.getWelcomeOffer(late, promoEnv(30), 'u1', NOW)).toBeNull()
    const broken = codesDb({ selectError: { code: '57014', message: 'timeout' } }).db
    await expect(welcome.getWelcomeOffer(broken, promoEnv(30), 'u1', NOW)).rejects.toMatchObject({ code: '57014' })
  })
})

describe('a welcome code prices for its own account only', () => {
  const codeRow = (over = {}) => ({
    id: 'rc1', partner_id: c.WELCOME_PARTNER_ID, code: 'FN-AAAAA', tier_prices: { FIX: 2030 }, active: true, usage_limit: 1, uses_so_far: 0,
    expires_at: iso(Date.now() + 5 * DAY), user_id: 'u1', partners: { status: 'ACTIVE', email: 'welcome-codes@system.invalid', previous_emails: [] }, ...over,
  })
  const db = row => createFakeSupabase(q => (q.table === 'referral_codes' && q.op === 'select' ? { data: row, error: null } : undefined))
  const env = () => promoEnv(30)
  const quote = (row, opts) => referral.resolvePricesForTiers(db(row), ['FIX'], env(), 'fn-aaaaa', opts).then(r => r.FIX)

  it('gives the owner the discount', async () => {
    const q = await quote(codeRow(), { buyerEmail: 'faith@example.com', buyerUserId: 'u1' })
    expect(q).toMatchObject({ amount: 2030, referralApplied: true })
  })
  it('gives anyone else the normal price, as if the code did not exist', async () => {
    const q = await quote(codeRow(), { buyerEmail: 'other@example.com', buyerUserId: 'u2' })
    expect(q).toMatchObject({ amount: 2900, referralApplied: false, referralCode: null })
  })
  it('gives an anonymous visitor (no account) the normal price', async () => {
    const q = await quote(codeRow(), {})
    expect(q).toMatchObject({ amount: 2900, referralApplied: false })
  })
  it('an ordinary partner code (no owner) still prices for everyone', async () => {
    const q = await quote(codeRow({ user_id: null, tier_prices: { FIX: 2500 } }), { buyerEmail: 'x@example.com', buyerUserId: 'u9' })
    expect(q).toMatchObject({ amount: 2500, referralApplied: true })
  })
  it("is not attached to a purchase it does not discount (the credential and fix-only tiers), so it is not spent for nothing", async () => {
    const all = await referral.resolvePricesForTiers(db(codeRow()), ['FIX', 'BADGE', 'FIX_PLAIN'], env(), 'FN-AAAAA', { buyerEmail: 'faith@example.com', buyerUserId: 'u1' })
    expect(all.FIX).toMatchObject({ amount: 2030, referralApplied: true })
    expect(all.BADGE).toMatchObject({ amount: 900, referralApplied: false, referralCode: null })
    expect(all.FIX_PLAIN).toMatchObject({ amount: 1900, referralApplied: false, referralCode: null })
  })
  it('whereas an ordinary partner code with no price for a tier still attributes the sale there', async () => {
    const all = await referral.resolvePricesForTiers(db(codeRow({ user_id: null, tier_prices: { FIX: 2500 } })), ['FIX', 'BADGE'], env(), 'FN-AAAAA', { buyerEmail: 'x@example.com', buyerUserId: 'u9' })
    expect(all.BADGE.referralApplied).toBe(true)
  })
  it('charges the percentage off the price in force when it is used: a promo that ended after issue does not deepen the discount', async () => {
    const standard = await referral.resolvePricesForTiers(db(codeRow()), ['FIX'], { PAYSTACK_CURRENCY: 'USD' }, 'FN-AAAAA', { buyerEmail: 'faith@example.com', buyerUserId: 'u1' })
    expect(standard.FIX).toMatchObject({ amount: 3430, referralApplied: true, discountApplied: true })   // 30% of $49, not the stored $20.30
  })
  it('and a promo that started after issue is respected too', async () => {
    const q = await quote(codeRow({ tier_prices: { FIX: 3430 } }), { buyerEmail: 'faith@example.com', buyerUserId: 'u1' })
    expect(q).toMatchObject({ amount: 2030 })                                                              // 30% of the $29 promo price
  })
  it('a used code does not apply even to its owner', async () => {
    const q = await quote(codeRow({ uses_so_far: 1 }), { buyerEmail: 'faith@example.com', buyerUserId: 'u1' })
    expect(q).toMatchObject({ amount: 2900, referralApplied: false })
  })
})

describe('GET /api/pricing/welcome-offer', () => {
  let t
  afterEach(() => t?.restore())
  const ctx = user => ({ env: promoEnv(30), get: k => (k === 'user' ? user : undefined), json: (body, status = 200) => ({ body, status }) })
  function load(offerFn) {
    t = loadWithStubs('controllers/pricing.controller.js', {
      'config/supabase.js': { getSupabase: () => ({}) },
      'services/welcomeCode.service.js': { getWelcomeOffer: offerFn },
    })
    return t.mod
  }

  it("returns the signed-in account's own offer", async () => {
    const seen = []
    const mod = load(async (_db, _env, userId) => { seen.push(userId); return { code: 'FN-AAAAA', percentOff: 30 } })
    const res = await mod.getWelcomeOffer(ctx({ id: 'u1' }))
    expect(res.body).toEqual({ success: true, data: { offer: { code: 'FN-AAAAA', percentOff: 30 } } })
    expect(seen).toEqual(['u1'])
  })
  it('says { offer: null } when there is none', async () => {
    const mod = load(async () => null)
    expect((await mod.getWelcomeOffer(ctx({ id: 'u1' }))).body.data.offer).toBeNull()
  })
})

describe('the route needs a signed-in account', () => {
  it('is registered behind the auth middleware', () => {
    const src = require('node:fs').readFileSync(new URL('../src/routes/pricing.routes.js', import.meta.url), 'utf8')
    expect(src).toMatch(/router\.get\('\/welcome-offer', auth, c\.getWelcomeOffer\)/)
  })
})
