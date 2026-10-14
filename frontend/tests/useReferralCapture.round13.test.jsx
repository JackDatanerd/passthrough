// @vitest-environment jsdom
// Section 4 round 13 (bug B2): a repeat ?ref= visit refreshes the browser's window, so the account must hear about it too.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({ data: { success: true } })) } }))
vi.mock('../src/lib/storage', () => ({ getToken: () => 'jwt', storageGet: () => null, storageSet: () => {}, storageRemove: () => {} }))

const mountAt = async entry => {
  const mod = await import('../src/hooks/useReferralCapture')
  renderHook(() => mod.useReferralCapture(), { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
  return mod
}

describe('useReferralCapture — repeat visit', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); api.post.mockClear() })

  it('pushes the refreshed window start to the account once, without logging another click', async () => {
    const old = Date.now() - 10 * 24 * 3600 * 1000
    localStorage.setItem('passthrough_referral_code', JSON.stringify({ code: 'COACH', capturedAt: old, source: 'link' }))
    await mountAt('/?ref=coach')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/attribution', expect.objectContaining({ code: 'COACH' })))
    const body = api.post.mock.calls.find(c => c[0] === '/partners/attribution')[1]
    expect(Date.parse(body.capturedAt)).toBeGreaterThan(old + 24 * 3600 * 1000)
    expect(api.post.mock.calls.some(c => c[0] === '/partners/track-click')).toBe(false)
  })

  it('exposes the capture time for registration', async () => {
    const at = Date.now() - 3 * 24 * 3600 * 1000
    localStorage.setItem('passthrough_referral_code', JSON.stringify({ code: 'COACH', capturedAt: at, source: 'link' }))
    const { getStoredReferralCapturedAt } = await import('../src/hooks/useReferralCapture')
    expect(getStoredReferralCapturedAt()).toBe(new Date(at).toISOString())
    localStorage.clear()
    vi.resetModules()
    const again = await import('../src/hooks/useReferralCapture')
    expect(again.getStoredReferralCapturedAt()).toBe('')
  })
})
