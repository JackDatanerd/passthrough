import { describe, it, expect } from 'vitest'
import { sha256, hmacSha512Hex, timingSafeEqual, randomToken, randomShortCode, uuid } from '../src/lib/crypto.js'

describe('crypto helpers', () => {
  it('sha256 matches a known vector', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('hmacSha512Hex matches a known vector (RFC 4231 test case 2)', async () => {
    expect(await hmacSha512Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737')
  })
  it('timingSafeEqual: equal, unequal, different lengths, empty', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', 'x')).toBe(false)
  })
  it('randomToken is hex of the requested byte length and does not repeat', () => {
    const a = randomToken(32), b = randomToken(32)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a === b).toBe(false)
  })
  it('randomShortCode uses only the given alphabet', () => {
    const code = randomShortCode(200, 'ABC')
    expect(code).toHaveLength(200)
    expect(code).toMatch(/^[ABC]+$/)
  })
  it('uuid looks like a v4 uuid', () => {
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
