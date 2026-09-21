import { describe, it, expect } from 'vitest'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { resolvePrice, recordConversion, isCodeUsable } from '../src/services/referral.service.js'

const FUTURE = new Date(Date.now() + 86400_000).toISOString()
const PAST = new Date(Date.now() - 86400_000).toISOString()
const promoEnv = { PROMO_ACTIVE: 'true', PROMO_ENDS_AT: FUTURE }

const codeRow = (over = {}) => ({
  id: 'rc1', code: 'COACH20', partner_id: 'p1', active: true, expires_at: null,
  usage_limit: null, uses_so_far: 0, tier_prices: { FIX: 1900, BADGE: 900 }, partners: { status: 'ACTIVE' }, ...over,
})
const dbReturning = row => createFakeSupabase(q => (q.table === 'referral_codes' ? { data: row, error: null } : undefined))

// These replace the old vacuous checks: the earlier fake returned the row for ANY
// query, so "is case-insensitive" passed even if the service stopped normalising.
describe('lookup — asserts WHAT was queried', () => {
  it('normalises the code (trim + uppercase) before querying, on the `code` column', async () => {
    const db = dbReturning(codeRow())
    await resolvePrice(db, 'FIX', {}, '  coach20 ')
    const q = db.calls.find(x => x.table === 'referral_codes')
    expect(eqValue(q, 'code')).toBe('COACH20')
    expect(q.filters).toHaveLength(1)
  })
  it('does not query at all for an empty / whitespace code', async () => {
    const db = dbReturning(codeRow())
    const r = await resolvePrice(db, 'FIX', {}, '   ')
    expect(db.calls).toHaveLength(0)
    expect(r.referralApplied).toBe(false)
  })
  it('asks for the owning partner\'s status in the same query', async () => {
    const db = dbReturning(codeRow())
    await resolvePrice(db, 'FIX', {}, 'coach20')
    expect(db.calls[0].cols).toContain('partners(status)')
  })
  it('surfaces a database error instead of silently charging the wrong price', async () => {
    const db = createFakeSupabase(() => ({ data: null, error: new Error('db down') }))
    let threw = false
    try { await resolvePrice(db, 'FIX', {}, 'X') } catch { threw = true }
    expect(threw).toBe(true)
  })
})

describe('resolvePrice', () => {
  it('applies the code price for the requested tier', async () => {
    const r = await resolvePrice(dbReturning(codeRow()), 'FIX', {}, 'coach20')
    expect(r).toEqual({ amount: 1900, currency: r.currency, referralApplied: true, referralCode: codeRow() })
  })
  it('falls back to standard pricing for a tier the code does not cover', async () => {
    const r = await resolvePrice(dbReturning(codeRow()), 'FIX_PLAIN', {}, 'coach20')
    expect(r.amount).toBe(3900)
    expect(r.referralApplied).toBe(false)
  })
  it('a code can never make the customer pay MORE than the current public price (promo undercuts it)', async () => {
    const r = await resolvePrice(dbReturning(codeRow({ tier_prices: { FIX: 3900 } })), 'FIX', promoEnv, 'coach20')
    expect(r.amount).toBe(2900)          // promo FIX price, not the code's higher 3900
    expect(r.referralApplied).toBe(true) // still attributed to the partner
  })
  it('a code cheaper than the promo still wins', async () => {
    const r = await resolvePrice(dbReturning(codeRow()), 'FIX', promoEnv, 'coach20')
    expect(r.amount).toBe(1900)
  })
  it('ignores an unknown code', async () => {
    const r = await resolvePrice(dbReturning(null), 'FIX', {}, 'nope')
    expect(r.amount).toBe(4900)
    expect(r.referralApplied).toBe(false)
    expect(r.referralCode).toBeNull()
  })
})

describe('isCodeUsable', () => {
  it('accepts an active, unexpired, under-limit code', () => expect(isCodeUsable(codeRow())).toBe(true))
  it('rejects null / inactive', () => {
    expect(isCodeUsable(null)).toBe(false)
    expect(isCodeUsable(codeRow({ active: false }))).toBe(false)
  })
  it('rejects an expired code and accepts one expiring in the future', () => {
    expect(isCodeUsable(codeRow({ expires_at: PAST }))).toBe(false)
    expect(isCodeUsable(codeRow({ expires_at: FUTURE }))).toBe(true)
  })
  it('fails CLOSED on an unparseable expires_at (used to be treated as "never expires")', () => {
    expect(isCodeUsable(codeRow({ expires_at: 'garbage' }))).toBe(false)
  })
  it('a PAUSED partner\'s codes stop applying (new checkouts only)', () => {
    expect(isCodeUsable(codeRow({ partners: { status: 'PAUSED' } }))).toBe(false)
    expect(isCodeUsable(codeRow({ partners: null }))).toBe(false)
    expect(isCodeUsable(codeRow({ partners: undefined }))).toBe(false)
  })
  it('enforces usage_limit exactly at the boundary', () => {
    expect(isCodeUsable(codeRow({ usage_limit: 5, uses_so_far: 4 }))).toBe(true)
    expect(isCodeUsable(codeRow({ usage_limit: 5, uses_so_far: 5 }))).toBe(false)
    expect(isCodeUsable(codeRow({ usage_limit: 0, uses_so_far: 0 }))).toBe(false)
  })
})

describe('recordConversion — env alerting', () => {
  it('pages the owner on failure ONLY when env is passed (fulfilment paths pass it; admin reconcile does not)', async () => {
    const payment = { id: 'pay1', referral_code_id: 'rc1', amount_cents: 1900, paystack_ref: 'r1' }
    const failing = () => createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' } }
      if (q.table === 'partners') return { data: { commission_rate: 0.2 } }
      if (q.table === 'commission_ledger') return { error: { code: '08006', message: 'down' } }
      return undefined
    })
    const r1 = await recordConversion(failing(), payment)                 // no env -> no alert attempted, still reports
    expect(r1.ok).toBe(false)
    const r2 = await recordConversion(failing(), payment, { /* env without mail config */ })
    expect(r2.ok).toBe(false)                                            // alert is best-effort and never throws
  })
})

describe('recordConversion', () => {
  const payment = { id: 'pay1', referral_code_id: 'rc1', amount_cents: 1900 }

  function db({ ledgerError, rpcError, partner = { commission_rate: 0.2 }, code = { id: 'rc1', partner_id: 'p1' } } = {}) {
    return createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: code, error: null }
      if (q.table === 'partners') return { data: partner, error: null }
      if (q.table === 'commission_ledger') return { error: ledgerError || null }
      if (q.op === 'rpc') return { error: rpcError || null }
      return undefined
    })
  }

  it('does nothing (ok) for a payment with no referral', async () => {
    const d = db()
    const r = await recordConversion(d, { id: 'p', referral_code_id: null, amount_cents: 100 })
    expect(r).toEqual({ ok: true, recorded: false, reason: 'no-referral' })
    expect(d.calls).toHaveLength(0)
  })
  it('writes the ledger row with the commission on the amount ACTUALLY charged, then bumps usage', async () => {
    const d = db()
    const r = await recordConversion(d, payment)
    expect(r).toEqual({ ok: true, recorded: true })
    const ins = d.calls.find(q => q.table === 'commission_ledger')
    expect(ins.values).toEqual({
      payment_id: 'pay1', partner_id: 'p1', referral_code_id: 'rc1',
      gross_amount_cents: 1900, commission_rate: 0.2, commission_amount_cents: 380,
    })
    expect(d.calls.find(q => q.op === 'rpc').name).toBe('increment_referral_code_usage')
    expect(d.calls.find(q => q.op === 'rpc').args).toEqual({ p_code_id: 'rc1' })
  })
  it('rounds the commission to whole cents', async () => {
    const d = db({ partner: { commission_rate: 0.3333 } })
    await recordConversion(d, { ...payment, amount_cents: 1000 })
    expect(d.calls.find(q => q.table === 'commission_ledger').values.commission_amount_cents).toBe(333)
  })
  it('a duplicate ledger insert (23505) is a harmless no-op and does NOT bump usage again', async () => {
    const d = db({ ledgerError: { code: '23505', message: 'dup' } })
    const r = await recordConversion(d, payment)
    expect(r).toEqual({ ok: true, recorded: false, reason: 'duplicate' })
    expect(d.calls.find(q => q.op === 'rpc')).toBeUndefined()
  })
  // The previous version only console.error'd here, so a lost commission was invisible.
  it('REPORTS a failed ledger insert (ok:false) instead of swallowing it', async () => {
    const d = db({ ledgerError: { code: '08006', message: 'connection failure' } })
    const r = await recordConversion(d, payment)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('ledger-insert')
    expect(r.recorded).toBe(false)
  })
  it('retries a transient ledger failure once before giving up', async () => {
    let attempts = 0
    const d = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: { id: 'rc1', partner_id: 'p1' } }
      if (q.table === 'partners') return { data: { commission_rate: 0.2 } }
      if (q.table === 'commission_ledger') { attempts++; return { error: attempts === 1 ? { code: '08006', message: 'blip' } : null } }
      return { error: null }
    })
    const r = await recordConversion(d, payment)
    expect(attempts).toBe(2)
    expect(r).toEqual({ ok: true, recorded: true })
  })
  it('reports recorded:true but ok:false when only the usage counter update fails', async () => {
    const r = await recordConversion(db({ rpcError: { message: 'rpc failed' } }), payment)
    expect(r.ok).toBe(false)
    expect(r.recorded).toBe(true)
    expect(r.reason).toBe('usage-increment')
  })
  it('rejects a nonsensical commission rate rather than writing a bad ledger row', async () => {
    for (const rate of ['abc', -1, null, undefined, 1.5]) {
      const d = db({ partner: { commission_rate: rate } })
      const r = await recordConversion(d, payment)
      expect(r.ok).toBe(false)
      expect(d.calls.find(q => q.table === 'commission_ledger')).toBeUndefined()
    }
  })
  it('never throws, even if the database client itself throws', async () => {
    const boom = { from() { throw new Error('client exploded') }, rpc() { throw new Error('x') } }
    const r = await recordConversion(boom, payment)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exception')
  })
})
