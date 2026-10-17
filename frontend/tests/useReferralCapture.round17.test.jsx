// @vitest-environment jsdom
// Section 4 round 17: the partner's channel tag (&sub=) rides on the signed-in ACCOUNT with the code, so a purchase on another
// device (or after clearing site data) is still tagged.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({ data: { data: { stored: true } } })) } }))
vi.mock('../src/lib/storage', () => ({ getToken: () => 'token' }))

const KEY = 'passthrough_referral_code'
const DAY = 24 * 3600 * 1000
const record = () => JSON.parse(localStorage.getItem(KEY))
const load = () => import('../src/hooks/useReferralCapture')

describe('referral tag on the account', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); api.post.mockClear() })

  it('restoring from the account brings the tag back with the code', async () => {
    const mod = await load()
    const at = Date.now() - 2 * DAY
    mod.restoreReferralFromAccount({ referredByCode: 'COACH', referredAt: new Date(at).toISOString(), referredSub: 'newsletter' })
    expect(record()).toMatchObject({ code: 'COACH', source: 'account', sub: 'newsletter' })
    expect(mod.getStoredReferralSub()).toBe('newsletter')
  })
  it('an account with no tag restores no tag, and a junk tag is dropped', async () => {
    const mod = await load()
    mod.restoreReferralFromAccount({ referredByCode: 'COACH', referredAt: new Date(Date.now() - DAY).toISOString(), referredSub: 'not valid!' })
    expect(record().sub).toBeUndefined()
  })
  it('typing the same code pushes its kept tag to the account', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 1000, source: 'link', sub: 'yt' }))
    const mod = await load()
    mod.setStoredReferralCode('coach')
    expect(api.post).toHaveBeenCalledWith('/partners/attribution', expect.objectContaining({ code: 'COACH', sub: 'yt' }))
  })
  it('typing a different code pushes no tag', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: Date.now() - 1000, source: 'link', sub: 'yt' }))
    const mod = await load()
    mod.setStoredReferralCode('OTHER')
    const body = api.post.mock.calls.at(-1)[1]
    expect(body.code).toBe('OTHER')
    expect(body).not.toHaveProperty('sub')
  })
  it('a local tag the account does not have yet is handed over (same code, this click is not older)', async () => {
    const at = Date.now() - 3 * DAY
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: at, source: 'link', sub: 'yt' }))
    const mod = await load()
    mod.restoreReferralFromAccount({ referredByCode: 'COACH', referredAt: new Date(at - DAY).toISOString(), referredSub: null })
    expect(api.post).toHaveBeenCalledWith('/partners/attribution', { code: 'COACH', capturedAt: new Date(at).toISOString(), sub: 'yt' })
  })
  it('does not re-send when the account already holds the same tag, or its click is the newer one', async () => {
    const at = Date.now() - 3 * DAY
    localStorage.setItem(KEY, JSON.stringify({ code: 'COACH', capturedAt: at, source: 'link', sub: 'yt' }))
    const mod = await load()
    mod.restoreReferralFromAccount({ referredByCode: 'COACH', referredAt: new Date(at).toISOString(), referredSub: 'yt' })
    mod.restoreReferralFromAccount({ referredByCode: 'COACH', referredAt: new Date(at + DAY).toISOString(), referredSub: null })
    expect(api.post).not.toHaveBeenCalled()
  })
  it('a code pushed to the account with a different code carries its tag', async () => {
    const at = Date.now() - DAY
    localStorage.setItem(KEY, JSON.stringify({ code: 'NEW', capturedAt: at, source: 'link', sub: 'ig' }))
    const mod = await load()
    mod.restoreReferralFromAccount({ referredByCode: 'OLD', referredAt: new Date(at - 5 * DAY).toISOString(), referredSub: 'x' })
    expect(api.post).toHaveBeenCalledWith('/partners/attribution', { code: 'NEW', capturedAt: new Date(at).toISOString(), sub: 'ig' })
  })
})
