// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { storageGet, storageSet, storageRemove, getToken, setToken, getCachedUser, setCachedUser } from '../src/lib/storage'

// Auth round 3 (B5): a browser with storage blocked throws SecurityError on ANY access, which used to
// white-screen the app from AuthProvider's first render.
describe('lib/storage', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('reads and writes through localStorage normally', () => {
    expect(storageSet('k', 'v')).toBe(true)
    expect(localStorage.getItem('k')).toBe('v')
    expect(storageGet('k')).toBe('v')
    storageRemove('k')
    expect(storageGet('k')).toBeNull()
  })

  it('never throws when storage is blocked, and keeps the value in memory for this page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(storageGet('blocked-key')).toBeNull()
    expect(storageSet('blocked-key', 'abc')).toBe(false)
    expect(storageGet('blocked-key')).toBe('abc')           // this visit still works
    expect(() => storageRemove('blocked-key')).not.toThrow()
    expect(storageGet('blocked-key')).toBeNull()
  })

  it('token and cached-user helpers round-trip, and a corrupt cached user reads as null', () => {
    setToken('tok'); expect(getToken()).toBe('tok')
    setCachedUser({ id: 'u1' }); expect(getCachedUser()).toEqual({ id: 'u1' })
    localStorage.setItem('passthrough_user', '{not json')
    expect(getCachedUser()).toBeNull()
  })
})
