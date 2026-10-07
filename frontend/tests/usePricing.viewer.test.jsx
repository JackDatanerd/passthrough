// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))

// Payments & Pricing round 3, B3: the pricing cache is keyed by VIEWER + code. /api/pricing withholds a
// referral discount from the code's own owner, so an anonymous quote is wrong for them once logged in.
const quote = (amount) => ({ data: { data: { tiers: [{ tier: 'FIX', amount, originalAmount: 4900 }], serverTime: Date.now() } } })
// Fresh module graph per test (the cache is module-level), so api / AuthContext / the hook are all
// imported AFTER resetModules and share one instance.
let api, AuthContext, usePricing
beforeEach(async () => {
  vi.resetModules()
  api = (await import('../src/lib/api')).default
  AuthContext = (await import('../src/context/AuthContext')).AuthContext
  usePricing = (await import('../src/hooks/usePricing')).usePricing
  api.get.mockReset()
})
const wrap = (user) => ({ children }) => <AuthContext.Provider value={{ user }}>{children}</AuthContext.Provider>

describe('usePricing — viewer-scoped cache (B3)', () => {
  it('does not reuse an anonymous quote for the same code once the viewer is logged in', async () => {
    api.get.mockResolvedValueOnce(quote(1900)).mockResolvedValueOnce(quote(4900))

    const anon = renderHook(() => usePricing('COACH20'), { wrapper: wrap(null) })
    await waitFor(() => expect(anon.result.current.byTier('FIX').amount).toBe(1900))
    anon.unmount()

    // Same code, now logged in (e.g. the partner themself) — must NOT be served the cached 1900.
    const authed = renderHook(() => usePricing('COACH20'), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(authed.result.current.byTier('FIX').amount).toBe(4900))
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it('still shares one fetch between components for the same viewer and code', async () => {
    api.get.mockResolvedValue(quote(1900))
    const a = renderHook(() => usePricing('COACH20'), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(a.result.current.byTier('FIX').amount).toBe(1900))
    const b = renderHook(() => usePricing('COACH20'), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(b.result.current.byTier('FIX').amount).toBe(1900))
    expect(api.get).toHaveBeenCalledTimes(1)
  })

  it('sends the bare (uppercased) code as ?ref= — the viewer is never part of the URL', async () => {
    api.get.mockResolvedValue(quote(1900))
    renderHook(() => usePricing(' coach20 '), { wrapper: wrap({ id: 'u1' }) })
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(api.get).toHaveBeenCalledWith('/pricing?ref=COACH20')
  })

  it('works with no AuthProvider at all (null-safe)', async () => {
    api.get.mockResolvedValue(quote(4900))
    const { result } = renderHook(() => usePricing())
    await waitFor(() => expect(result.current.byTier('FIX').amount).toBe(4900))
    expect(api.get).toHaveBeenCalledWith('/pricing')
  })
})
