// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() }, getErrorMessage: (e, f) => f }))

const quote = (amount) => ({ data: { data: { tiers: [{ tier: 'FIX', amount, originalAmount: 4900 }], serverTime: Date.now() } } })
let api, AuthContext, usePricing
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/lib/api')).default
  AuthContext = (await import('../src/context/AuthContext')).AuthContext
  usePricing = (await import('../src/hooks/usePricing')).usePricing
  api.get.mockReset()
})
const wrap = (user) => ({ children }) => <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>

// Payments & Pricing round 9 (B2): the checkout screen tells the server which scan it is for, so a slot the
// buyer holds on ANOTHER scan is not netted off their quote. Without a code the scan can't change the answer.
describe('usePricing — scan scope', () => {
  it('sends scanId with a referral code', async () => {
    api.get.mockResolvedValue(quote(1900))
    const { result } = renderHook(() => usePricing('abc', { scanId: 'scan-1' }), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(1900))
    expect(api.get.mock.calls[0][0]).toBe('/pricing?ref=ABC&scanId=scan-1')
  })
  it('omits scanId when there is no code (and the cache is shared across scans)', async () => {
    api.get.mockResolvedValue(quote(4900))
    const a = renderHook(() => usePricing('', { scanId: 'scan-1' }), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(a.result.current.byTier('FIX').amount).toBe(4900))
    const b = renderHook(() => usePricing('', { scanId: 'scan-2' }), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(b.result.current.byTier('FIX').amount).toBe(4900))
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get.mock.calls[0][0]).toBe('/pricing')
  })
  it('a different scan with the same code is a different cache slot', async () => {
    api.get.mockResolvedValueOnce(quote(1900)).mockResolvedValueOnce(quote(4900))
    const { result, rerender } = renderHook(({ s }) => usePricing('abc', { scanId: s }), { initialProps: { s: 'scan-1' }, wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(1900))
    rerender({ s: 'scan-2' })
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(4900))
    expect(api.get.mock.calls[1][0]).toBe('/pricing?ref=ABC&scanId=scan-2')
  })
})
