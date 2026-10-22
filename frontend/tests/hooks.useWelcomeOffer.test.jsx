// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import api from '../src/lib/api'
import { useWelcomeOffer } from '../src/hooks/useWelcomeOffer'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))
const future = () => new Date(Date.now() + 864e5).toISOString()
beforeEach(() => api.get.mockReset())

describe('useWelcomeOffer', () => {
  it('asks the server for the signed-in account\'s offer and returns it', async () => {
    api.get.mockResolvedValue({ data: { data: { offer: { code: 'FN-7K2QH', expiresAt: future() } } } })
    const { result } = renderHook(() => useWelcomeOffer({ id: 'u1' }))
    await waitFor(() => expect(result.current?.code).toBe('FN-7K2QH'))
    expect(api.get).toHaveBeenCalledWith('/pricing/welcome-offer')
  })
  it('makes no request when signed out', () => {
    const { result } = renderHook(() => useWelcomeOffer(null))
    expect(result.current).toBeNull()
    expect(api.get).not.toHaveBeenCalled()
  })
  it('returns null when there is no offer, or the request fails', async () => {
    api.get.mockResolvedValueOnce({ data: { data: { offer: null } } })
    const a = renderHook(() => useWelcomeOffer({ id: 'u1' }))
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(a.result.current).toBeNull()
    api.get.mockRejectedValueOnce(new Error('down'))
    const b = renderHook(() => useWelcomeOffer({ id: 'u2' }))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    expect(b.result.current).toBeNull()
  })
  it('treats an offer past its expiry as none', async () => {
    api.get.mockResolvedValue({ data: { data: { offer: { code: 'OLD', expiresAt: new Date(Date.now() - 1000).toISOString() } } } })
    const { result } = renderHook(() => useWelcomeOffer({ id: 'u1' }))
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
  it('forgets the offer when the account signs out', async () => {
    api.get.mockResolvedValue({ data: { data: { offer: { code: 'FN-7K2QH', expiresAt: future() } } } })
    const { result, rerender } = renderHook(({ u }) => useWelcomeOffer(u), { initialProps: { u: { id: 'u1' } } })
    await waitFor(() => expect(result.current?.code).toBe('FN-7K2QH'))
    rerender({ u: null })
    await waitFor(() => expect(result.current).toBeNull())
  })
  describe('the code is issued just after verification', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())
    const tick = ms => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
    const fresh = () => ({ id: 'u1', emailVerified: true, createdAt: new Date().toISOString() })

    it('asks again a few times for a verified, new account that has no offer yet, and shows it once it appears', async () => {
      api.get.mockResolvedValueOnce({ data: { data: { offer: null } } })
        .mockResolvedValueOnce({ data: { data: { offer: null } } })
        .mockResolvedValue({ data: { data: { offer: { code: 'FN-7K2QH', expiresAt: future() } } } })
      const { result } = renderHook(() => useWelcomeOffer(fresh()))
      await tick(0)
      expect(result.current).toBeNull()
      await tick(2000)
      expect(result.current).toBeNull()
      await tick(4000)
      expect(result.current?.code).toBe('FN-7K2QH')
      expect(api.get).toHaveBeenCalledTimes(3)
    })
    it('gives up after three retries', async () => {
      api.get.mockResolvedValue({ data: { data: { offer: null } } })
      renderHook(() => useWelcomeOffer(fresh()))
      await tick(60000)
      expect(api.get).toHaveBeenCalledTimes(4)
    })
    it('asks once for an older account, and once for an account that has not verified', async () => {
      api.get.mockResolvedValue({ data: { data: { offer: null } } })
      renderHook(() => useWelcomeOffer({ id: 'u1', emailVerified: true, createdAt: new Date(Date.now() - 30 * 864e5).toISOString() }))
      renderHook(() => useWelcomeOffer({ id: 'u2', emailVerified: false, createdAt: new Date().toISOString() }))
      await tick(60000)
      expect(api.get).toHaveBeenCalledTimes(2)
    })
    it('asks again when the account becomes verified', async () => {
      api.get.mockResolvedValue({ data: { data: { offer: null } } })
      const { rerender } = renderHook(({ u }) => useWelcomeOffer(u), { initialProps: { u: { id: 'u1', emailVerified: false, createdAt: new Date(Date.now() - 30 * 864e5).toISOString() } } })
      await tick(0)
      expect(api.get).toHaveBeenCalledTimes(1)
      rerender({ u: { id: 'u1', emailVerified: true, createdAt: new Date(Date.now() - 30 * 864e5).toISOString() } })
      await tick(0)
      expect(api.get).toHaveBeenCalledTimes(2)
    })
  })
})
