// @vitest-environment jsdom
// Section 4 round 16: the partner's channel tag (?sub=) is captured with the code, validated, and only ever kept alongside it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({ data: { valid: true } })) } }))
vi.mock('../src/lib/storage', () => ({ getToken: () => null }))

const KEY = 'passthrough_referral_code'
const record = () => JSON.parse(localStorage.getItem(KEY))
const mountAt = async entry => {
  const mod = await import('../src/hooks/useReferralCapture')
  renderHook(() => mod.useReferralCapture(), { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
  return mod
}

describe('useReferralCapture: channel tag', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); api.post.mockClear(); window.history.replaceState({}, '', '/') })

  it('stores a valid tag (lower-cased) with the code and exposes it', async () => {
    const mod = await mountAt('/?ref=coach&sub=NewsLetter')
    expect(record()).toMatchObject({ code: 'COACH', source: 'link', sub: 'newsletter' })
    expect(mod.getStoredReferralSub()).toBe('newsletter')
  })
  it('drops an invalid tag but still captures the code', async () => {
    const mod = await mountAt('/?ref=coach&sub=' + encodeURIComponent('not valid!'))
    expect(record().code).toBe('COACH')
    expect(record().sub).toBeUndefined()
    expect(mod.getStoredReferralSub()).toBe('')
  })
  it('ignores a tag that arrives without a code', async () => {
    const mod = await mountAt('/?sub=newsletter')
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(mod.getStoredReferralSub()).toBe('')
  })
  it('typing the same code keeps the tag; a different code does not inherit it', async () => {
    const mod = await mountAt('/?ref=coach&sub=yt')
    mod.setStoredReferralCode('coach')
    expect(record()).toMatchObject({ code: 'COACH', source: 'typed', sub: 'yt' })
    mod.setStoredReferralCode('OTHER')
    expect(record().sub).toBeUndefined()
  })
  it('a newer link without a tag replaces the old tag (last click wins)', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 1000, source: 'link', sub: 'old' }))
    await mountAt('/?ref=coach')
    expect(record().sub).toBeUndefined()
  })
  it('an expired record gives no tag', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 40 * 86400000, source: 'link', sub: 'old' }))
    const mod = await import('../src/hooks/useReferralCapture')
    expect(mod.getStoredReferralSub()).toBe('')
  })
})
