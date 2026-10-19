import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Round 20 (bug): a code removed from localStorage elsewhere (another tab, site data wiped) must not be resurrected from this tab's
// in-memory copy — that copy is only for browsers where storage itself is unavailable.
function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear(), _store: store }
}
let real
beforeEach(() => { real = globalThis.localStorage; globalThis.localStorage = makeLocalStorage() })
afterEach(() => { globalThis.localStorage = real; vi.restoreAllMocks(); vi.resetModules() })
const load = () => import('../src/hooks/useReferralCapture.js')

describe('stored referral code and the in-memory copy', () => {
  it('a code cleared from storage by someone else stays gone', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await load()
    setStoredReferralCode('ANN10')
    expect(getStoredReferralCode()).toBe('ANN10')
    globalThis.localStorage.clear()                 // another tab removed it / site data wiped
    expect(getStoredReferralCode()).toBe('')
  })
  it('a code replaced by another tab is read from storage, not from memory', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await load()
    setStoredReferralCode('ANN10')
    const rec = JSON.parse(globalThis.localStorage.getItem('passthrough_referral_code'))
    globalThis.localStorage.setItem('passthrough_referral_code', JSON.stringify({ ...rec, code: 'BOB20' }))
    expect(getStoredReferralCode()).toBe('BOB20')
  })
  it('when storage refuses writes, the in-memory copy keeps the code for this page', async () => {
    globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {}, clear: () => {} }
    const { setStoredReferralCode, getStoredReferralCode } = await load()
    setStoredReferralCode('ANN10')
    expect(getStoredReferralCode()).toBe('ANN10')
  })
  it('when storage throws on read, the in-memory copy is used', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await load()
    setStoredReferralCode('ANN10')
    globalThis.localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {}, clear: () => {} }
    expect(getStoredReferralCode()).toBe('ANN10')
  })
})
