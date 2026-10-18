// @vitest-environment jsdom
// Section 4 round 19: a returning visitor who arrives through ANOTHER channel tag of the same code is a visit to that channel.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({ data: { valid: true } })) } }))
vi.mock('../src/lib/storage', () => ({ getToken: () => null }))

const KEY = 'passthrough_referral_code'
const mountAt = async entry => {
  const mod = await import('../src/hooks/useReferralCapture')
  renderHook(() => mod.useReferralCapture(), { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
  return mod
}
const clicks = () => api.post.mock.calls.filter(c => c[0] === '/partners/track-click').map(c => c[1])

describe('useReferralCapture: channel visits', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); api.post.mockClear(); window.history.replaceState({}, '', '/') })

  it('a different tag on the same live code sends a channel-only click', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 1000, source: 'link', sub: 'news' }))
    await mountAt('/?ref=coach&sub=yt')
    expect(clicks()).toEqual([{ code: 'COACH', sub: 'yt', subOnly: true }])
    expect(JSON.parse(localStorage.getItem(KEY)).sub).toBe('yt')
  })
  it('the same tag again is not a new visit', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 1000, source: 'link', sub: 'news' }))
    await mountAt('/?ref=coach&sub=news')
    expect(clicks()).toEqual([])
  })
  it('a brand-new code still counts as a normal click', async () => {
    await mountAt('/?ref=coach&sub=yt')
    expect(clicks()).toEqual([{ code: 'COACH', sub: 'yt' }])
  })
})
