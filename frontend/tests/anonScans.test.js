import { describe, it, expect, beforeEach } from 'vitest'
import { addAnonScanToken, getAnonScanToken, getAnonScanTokens, removeAnonScanToken, clearAnonScanTokens } from '../src/lib/anonScans.js'

// Minimal localStorage double so this file can run outside a browser/jsdom.
function makeStorage({ throwOnSet = false } = {}) {
  const store = new Map()
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (throwOnSet) throw new DOMException('QuotaExceededError'); store.set(k, v) },
    removeItem: k => store.delete(k),
  }
}

describe('anonScans — survives a failing localStorage (Scan/ATS pass)', () => {
  beforeEach(() => { clearAnonScanTokens() })

  it('normal case: token round-trips through localStorage', () => {
    globalThis.localStorage = makeStorage()
    addAnonScanToken('scan-1', 'tok-1')
    expect(getAnonScanToken('scan-1')).toBe('tok-1')
    expect(getAnonScanTokens()).toContainEqual({ scanId: 'scan-1', token: 'tok-1' })
  })

  it('a throwing setItem (quota exceeded / private mode) does not lose the token for this page', () => {
    globalThis.localStorage = makeStorage({ throwOnSet: true })
    expect(() => addAnonScanToken('scan-2', 'tok-2')).not.toThrow()
    // Not persisted...
    expect(JSON.parse(globalThis.localStorage.getItem('passthrough_anon_tokens') || '[]')).toEqual([])
    // ...but still readable in this tab, so ScanResult can navigate/claim/view it.
    expect(getAnonScanToken('scan-2')).toBe('tok-2')
    expect(getAnonScanTokens()).toContainEqual({ scanId: 'scan-2', token: 'tok-2' })
  })

  it('removeAnonScanToken and clearAnonScanTokens also do not throw when storage is unusable', () => {
    globalThis.localStorage = makeStorage({ throwOnSet: true })
    addAnonScanToken('scan-3', 'tok-3')
    expect(() => removeAnonScanToken('scan-3')).not.toThrow()
    expect(getAnonScanToken('scan-3')).toBeNull()
    addAnonScanToken('scan-4', 'tok-4')
    expect(() => clearAnonScanTokens()).not.toThrow()
    expect(getAnonScanToken('scan-4')).toBeNull()
  })

  it('a throwing getItem (storage disabled entirely) still lets add/get work via memory', () => {
    globalThis.localStorage = { getItem: () => { throw new Error('disabled') }, setItem: () => { throw new Error('disabled') }, removeItem: () => {} }
    addAnonScanToken('scan-5', 'tok-5')
    expect(getAnonScanToken('scan-5')).toBe('tok-5')
  })
})
