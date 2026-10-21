// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
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
})
