// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() }, getErrorMessage: (e, f) => f }))

const quote = (amount, extra = {}) => ({ data: { data: { tiers: [{ tier: 'FIX', amount, originalAmount: 4900 }], serverTime: Date.now(), ...extra } } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
let api, AuthContext, usePricing
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/lib/api')).default
  AuthContext = (await import('../src/context/AuthContext')).AuthContext
  usePricing = (await import('../src/hooks/usePricing')).usePricing
  api.get.mockReset()
})
const wrap = (user) => ({ children }) => <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>

describe('usePricing — key switch', () => {
  it('never shows the previous code\'s prices on the render right after the code changes', async () => {
    api.get.mockResolvedValueOnce(quote(1900, { referralApplied: true })).mockImplementationOnce(() => new Promise(() => {}))
    const seen = []
    const { result, rerender } = renderHook(({ code }) => { const r = usePricing(code); seen.push([code, r.pricing?.referralApplied ?? null]); return r }, { initialProps: { code: 'AAA' }, wrapper: wrap(null) })
    await waitFor(() => expect(result.current.pricing?.referralApplied).toBe(true))
    seen.length = 0
    rerender({ code: 'BBB' })
    expect(seen.filter(([c]) => c === 'BBB').every(([, applied]) => applied === null)).toBe(true)
  })

  it('a refresh that finishes after the code changed does not overwrite the new code\'s slot', async () => {
    const slow = deferred()
    api.get.mockResolvedValueOnce(quote(1900)).mockReturnValueOnce(slow.promise).mockResolvedValueOnce(quote(1500))
    const { result, rerender } = renderHook(({ code }) => usePricing(code), { initialProps: { code: 'AAA' }, wrapper: wrap(null) })
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(1900))
    let pending
    act(() => { pending = result.current.refresh() })   // in flight for AAA
    rerender({ code: 'BBB' })
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(1500))
    await act(async () => { slow.resolve(quote(1900)); await pending })   // late AAA response
    expect(result.current.byTier('FIX').amount).toBe(1500)
  })
})
