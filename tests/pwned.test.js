import { describe, it, expect } from 'vitest'
import { pwnedCount, isPwnedPassword } from '../src/lib/pwned.js'
import { sha1Hex } from '../src/lib/crypto.js'

const HASH_PASSWORD = '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8' // sha1('password'), uppercase
const rangeBody = (suffix, count) => `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0\r\n${suffix}:${count}\r\n0000000000000000000000000000000000:0`

describe('pwnedCount — Have I Been Pwned range API (k-anonymity)', () => {
  it('only sends the first 5 hex chars of the SHA-1 hash — never the password or the full hash', async () => {
    let seenUrl
    const fetchImpl = async url => { seenUrl = url; return { ok: true, text: async () => rangeBody(HASH_PASSWORD.slice(5), 5) } }
    await pwnedCount('password', {}, fetchImpl)
    expect(seenUrl).toBe('https://api.pwnedpasswords.com/range/5BAA6')
    // Only the 5-char prefix of the hash travels — not the full 40-char hash,
    // and nowhere does the literal password appear.
    expect(seenUrl).not.toContain(HASH_PASSWORD)
    expect(seenUrl).not.toContain('=password')
  })
  it('sends Add-Padding: true (response-size side channel resistance)', async () => {
    let seenHeaders
    const fetchImpl = async (_url, opts) => { seenHeaders = opts.headers; return { ok: true, text: async () => '' } }
    await pwnedCount('password', {}, fetchImpl)
    expect(seenHeaders['Add-Padding']).toBe('true')
  })
  it('finds the matching suffix and returns its breach count', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => rangeBody(HASH_PASSWORD.slice(5), 3861493) })
    expect(await pwnedCount('password', {}, fetchImpl)).toBe(3861493)
  })
  it('returns 0 for a suffix that is not in the response (clean password)', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => rangeBody('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 1) })
    expect(await pwnedCount('a-genuinely-unique-passphrase-xyz', {}, fetchImpl)).toBe(0)
  })
  it('FAILS OPEN (returns null, never throws) on a non-OK response', async () => {
    const fetchImpl = async () => ({ ok: false, text: async () => '' })
    expect(await pwnedCount('password', {}, fetchImpl)).toBeNull()
  })
  it('FAILS OPEN on a network error / timeout', async () => {
    const fetchImpl = async () => { throw new Error('timeout') }
    expect(await pwnedCount('password', {}, fetchImpl)).toBeNull()
  })
  it('FAILS OPEN on garbage response text', async () => {
    const fetchImpl = async () => ({ ok: true, text: async () => 'not-the-expected-format-at-all' })
    expect(await pwnedCount('password', {}, fetchImpl)).toBe(0) // no line matches -> genuinely 0, still not a throw
  })
  it('is disabled by PWNED_PASSWORDS_CHECK=off, without ever calling fetch', async () => {
    const fetchImpl = async () => { throw new Error('should not be called') }
    expect(await pwnedCount('password', { PWNED_PASSWORDS_CHECK: 'off' }, fetchImpl)).toBeNull()
  })
})

describe('isPwnedPassword', () => {
  it('true only for a positive breach count', async () => {
    const hit = async () => ({ ok: true, text: async () => rangeBody(HASH_PASSWORD.slice(5), 1) })
    expect(await isPwnedPassword('password', {}, hit)).toBe(true)
  })
  it('false when the check could not run (fail open never blocks registration)', async () => {
    const down = async () => { throw new Error('down') }
    expect(await isPwnedPassword('password', {}, down)).toBe(false)
  })
  it('false for a count of 0', async () => {
    const clean = async () => ({ ok: true, text: async () => rangeBody('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', 1) })
    expect(await isPwnedPassword('a-genuinely-unique-passphrase-xyz', {}, clean)).toBe(false)
  })
})

describe('sha1Hex (lib/crypto.js) — matches HIBP\'s expected format', () => {
  it('produces uppercase hex, matching the known SHA-1 of "password"', async () => {
    expect(await sha1Hex('password')).toBe(HASH_PASSWORD)
  })
})
