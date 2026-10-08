// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, render, screen, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))

// Payments & Pricing round 6: B4 (a failed refetch must not leave expired promo prices on screen, and a
// failed fetch is retried a bounded number of times) and B5 (one referral confirmation, not two).
let api, usePricing
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/lib/api')).default
  usePricing = (await import('../src/hooks/usePricing')).usePricing
  api.get.mockReset()
})
afterEach(() => { vi.useRealTimers(); localStorage.clear() })

const promoQuote = (endsInMs) => ({ data: { data: {
  promoActive: true, promoEndsAt: new Date(Date.now() + endsInMs).toISOString(), serverTime: Date.now(),
  tiers: [{ tier: 'FIX', amount: 2900, originalAmount: 4900 }],
} } })

describe('usePricing — failure handling (B4)', () => {
  it('a failed refetch at the promo deadline drops the expired promo price back to standard instead of keeping it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockResolvedValueOnce(promoQuote(5_000)).mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => usePricing())
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(2900))

    await act(async () => { await vi.advanceTimersByTimeAsync(7_000) })     // past the deadline: refetch fires and fails
    await waitFor(() => expect(result.current.pricingFailed).toBe(true))
    expect(result.current.byTier('FIX').amount).toBe(4900)                  // standard, not the lapsed 2900
    expect(result.current.byTier('FIX').originalAmount).toBe(4900)
    expect(result.current.pricing).toBeNull()
  })

  it('a failed fetch is retried automatically and recovers on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockRejectedValueOnce(new Error('blip')).mockResolvedValue({ data: { data: { tiers: [{ tier: 'FIX', amount: 4900, originalAmount: 4900 }], serverTime: Date.now() } } })
    const { result } = renderHook(() => usePricing())
    await waitFor(() => expect(result.current.pricingFailed).toBe(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    await waitFor(() => expect(result.current.pricingFailed).toBe(false))
    expect(result.current.pricing).not.toBeNull()
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('automatic retries are bounded — a permanently failing endpoint is not hammered forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.get.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => usePricing())
    await waitFor(() => expect(result.current.pricingFailed).toBe(true))
    // One act() per step: React only re-runs the retry effect when an act scope exits, so a single
    // 10-minute act would stall the chain after the first retry.
    for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.get).toHaveBeenCalledTimes(1 + 4)                            // first try + MAX_AUTO_RETRIES
    expect(result.current.pricingFailed).toBe(true)
  })
})

describe('Pricing — one referral confirmation (B5)', () => {
  const tiers = (disc) => ['BADGE', 'FIX_PLAIN', 'FIX'].map(tier => ({ tier, amount: 1000, originalAmount: 2000, referralApplied: true, discountApplied: disc.includes(tier) }))
  async function renderPricing(disc) {
    const { setStoredReferralCode } = await import('../src/hooks/useReferralCapture')
    setStoredReferralCode('COACH20')
    api.get.mockResolvedValue({ data: { data: { referralApplied: true, discountApplied: disc.length > 0, tiers: tiers(disc), serverTime: Date.now() } } })
    const Pricing = (await import('../src/pages/Pricing')).default
    render(<MemoryRouter><Pricing /></MemoryRouter>)
    await screen.findByText(/Referral code/)
  }

  it('shows exactly one "Referral code … applied" confirmation when every plan is discounted', async () => {
    await renderPricing(['BADGE', 'FIX_PLAIN', 'FIX'])
    expect(screen.getAllByText(/Referral code/)).toHaveLength(1)
    expect(screen.queryByText(/lowers some of the plans/)).toBeNull()
  })

  it('adds the "some plans" note only when the code discounts some plans and not others', async () => {
    await renderPricing(['FIX'])
    expect(screen.getAllByText(/Referral code/)).toHaveLength(1)
    expect(screen.getByText(/lowers some of the plans below/)).toBeInTheDocument()
  })
})
