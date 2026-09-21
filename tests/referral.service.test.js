import { describe, it, expect } from 'vitest'
import { resolvePrice } from '../src/services/referral.service.js'

// Minimal fake Supabase client — just enough of the .from().select().eq().maybeSingle()
// chain that referral.service.js actually calls. Returns whatever row the
// test wires up for the code being looked up.
function fakeSupabase(codeRow) {
  return {
    from(table) {
      if (table !== 'referral_codes') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: (_col, _val) => ({
            maybeSingle: async () => ({ data: codeRow, error: null })
          })
        })
      }
    }
  }
}

const env = {}  // no PROMO_ACTIVE set — priceForTier falls back to standard prices

describe('referral.service — resolvePrice', () => {
  it('returns standard pricing with no discount when no code is given', async () => {
    const result = await resolvePrice(fakeSupabase(null), 'FIX', env, undefined)
    expect(result.referralApplied).toBe(false)
    expect(result.amount).toBe(4900)  // PRICE_FIX standard
  })

  it('applies the code price when active and within limits', async () => {
    const codeRow = {
      id: 'code-1', active: true, expires_at: null,
      usage_limit: null, uses_so_far: 0,
      tier_prices: { FIX: 1900 },
      partners: { status: 'ACTIVE' }   // codes of a paused/absent partner no longer apply (see isCodeUsable)
    }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'coach20')
    expect(result.referralApplied).toBe(true)
    expect(result.amount).toBe(1900)
    expect(result.referralCode.id).toBe('code-1')
  })

  it('is case-insensitive on the code string', async () => {
    const codeRow = { id: 'code-1', active: true, tier_prices: { FIX: 1900 }, partners: { status: 'ACTIVE' } }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'CoAcH20')
    expect(result.referralApplied).toBe(true)
  })

  it('falls through to standard pricing for an inactive code — does not block checkout', async () => {
    const codeRow = { id: 'code-1', active: false, tier_prices: { FIX: 1900 } }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'coach20')
    expect(result.referralApplied).toBe(false)
    expect(result.amount).toBe(4900)
  })

  it('falls through to standard pricing for an expired code', async () => {
    const codeRow = {
      id: 'code-1', active: true, expires_at: '2020-01-01T00:00:00Z',
      tier_prices: { FIX: 1900 }
    }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'coach20')
    expect(result.referralApplied).toBe(false)
  })

  it('falls through to standard pricing once usage_limit is reached', async () => {
    const codeRow = {
      id: 'code-1', active: true, expires_at: null,
      usage_limit: 10, uses_so_far: 10,
      tier_prices: { FIX: 1900 }
    }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'coach20')
    expect(result.referralApplied).toBe(false)
  })

  it('falls through to standard pricing for a tier the code does not discount', async () => {
    const codeRow = { id: 'code-1', active: true, tier_prices: { BADGE: 900 } }
    const result = await resolvePrice(fakeSupabase(codeRow), 'FIX', env, 'coach20')
    expect(result.referralApplied).toBe(false)
    expect(result.amount).toBe(4900)
  })

  it('falls through to standard pricing for an unknown code — never throws', async () => {
    const result = await resolvePrice(fakeSupabase(null), 'FIX', env, 'DOES-NOT-EXIST')
    expect(result.referralApplied).toBe(false)
    expect(result.amount).toBe(4900)
  })
})
