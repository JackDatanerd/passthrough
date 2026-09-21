import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// AUDIT FIX (feature gap): getStoredReferralCode()/setStoredReferralCode()
// used to store a bare code string with no expiry at all — once a browser
// captured a ?ref=CODE, every future purchase on it attributed to that
// partner forever, with nothing client-side to age it out (only the code's
// own server-side active/expires_at/usage_limit gated the PARTNER's side of
// things). This locks in the new 30-day attribution window.
//
// Runs under vitest.config.mjs's `node` environment (no DOM installed) —
// `localStorage` is stubbed the same way frontend/tests/api.test.js already
// does it, and only the plain exported functions are exercised. The
// useReferralCapture() hook itself needs a Router/DOM context this project's
// test setup doesn't install (see that config file's own comment), so — like
// every other React component/hook in this repo — it isn't unit tested here;
// only the localStorage-backed logic it shares with the manual "have a
// code?" entry path is.

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  }
}

const STORAGE_KEY = 'passthrough_referral_code'
let realLocalStorage

beforeEach(() => {
  realLocalStorage = globalThis.localStorage
  globalThis.localStorage = makeLocalStorage()
})

afterEach(() => {
  globalThis.localStorage = realLocalStorage
  vi.restoreAllMocks()
  vi.resetModules()
})

async function loadHook() {
  return import('../src/hooks/useReferralCapture.js')
}

describe('setStoredReferralCode / getStoredReferralCode', () => {
  it('round-trips a freshly-set code, uppercased and trimmed', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await loadHook()
    setStoredReferralCode('  coach20 ')
    expect(getStoredReferralCode()).toBe('COACH20')
  })

  it('clearing with an empty/falsy code removes it entirely', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await loadHook()
    setStoredReferralCode('COACH20')
    setStoredReferralCode('')
    expect(getStoredReferralCode()).toBe('')
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('a code captured just under 30 days ago is still returned', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await loadHook()
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    setStoredReferralCode('COACH20')
    Date.now.mockReturnValue(1_000_000_000_000 + (30 * 24 * 60 * 60 * 1000) - 1)
    expect(getStoredReferralCode()).toBe('COACH20')
  })

  it('a code captured more than 30 days ago has expired and is cleared', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await loadHook()
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    setStoredReferralCode('COACH20')
    Date.now.mockReturnValue(1_000_000_000_000 + (30 * 24 * 60 * 60 * 1000) + 1)
    expect(getStoredReferralCode()).toBe('')
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('a pre-fix, untimestamped raw-string value is treated as expired rather than immortal', async () => {
    const { getStoredReferralCode } = await loadHook()
    globalThis.localStorage.setItem(STORAGE_KEY, 'COACH20')   // legacy format: no {code, capturedAt}
    expect(getStoredReferralCode()).toBe('')
    expect(globalThis.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('corrupt JSON in storage is treated as absent, not thrown', async () => {
    const { getStoredReferralCode } = await loadHook()
    globalThis.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(getStoredReferralCode()).toBe('')
  })

  it('re-entering the same code manually refreshes the attribution window', async () => {
    const { setStoredReferralCode, getStoredReferralCode } = await loadHook()
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    setStoredReferralCode('COACH20')
    // Jump forward past the original window, but re-set the code first —
    // exactly what a repeat ?ref= visit or a manual re-entry does.
    Date.now.mockReturnValue(1_000_000_000_000 + (40 * 24 * 60 * 60 * 1000))
    setStoredReferralCode('COACH20')
    Date.now.mockReturnValue(1_000_000_000_000 + (40 * 24 * 60 * 60 * 1000) + (29 * 24 * 60 * 60 * 1000))
    expect(getStoredReferralCode()).toBe('COACH20')
  })
})
