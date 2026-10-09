// @vitest-environment jsdom
// Section 4 round 7 (bug): a `?ref=` that cannot be a referral code must never be stored — it used to replace a real
// partner's attribution (an over-long value even got a bare success from the server, so nothing undid it).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({ data: { success: true } })) } }))

const mountAt = async entry => {
  const { useReferralCapture, getStoredReferralCode } = await import('../src/hooks/useReferralCapture')
  renderHook(() => useReferralCapture(), { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
  return getStoredReferralCode
}

describe('useReferralCapture — values that are not codes', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); api.post.mockClear() })

  it('an over-long ?ref= keeps the real stored code and tracks nothing', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await import('../src/hooks/useReferralCapture')
    setStoredReferralCode('REALCODE')
    vi.resetModules()
    const get = await mountAt(`/?ref=${'x'.repeat(120)}`)
    await new Promise(r => setTimeout(r, 20))
    expect(get()).toBe('REALCODE')
    expect(api.post).not.toHaveBeenCalled()
    expect(getStoredReferralCode).toBeTypeOf('function')
  })

  it('characters a code can never contain are ignored the same way', async () => {
    const { setStoredReferralCode } = await import('../src/hooks/useReferralCapture')
    setStoredReferralCode('REALCODE')
    vi.resetModules()
    const get = await mountAt('/?ref=utm%20source%3Dx')
    await new Promise(r => setTimeout(r, 20))
    expect(get()).toBe('REALCODE')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('a well-formed code is still captured and tracked', async () => {
    const get = await mountAt('/?ref=coach_20')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/partners/track-click', { code: 'COACH_20' }))
    expect(get()).toBe('COACH_20')
  })
})
