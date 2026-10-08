import { describe, it, expect } from 'vitest'
import { extractVerificationCode } from '../src/lib/verificationCode'

// Round-5 (Section 7): /check accepts a pasted link or a code typed off a printed resume.
describe('extractVerificationCode', () => {
  it.each([
    ['AB3XY7K2PQ', 'AB3XY7K2PQ'],
    ['  ab3xy7k2pq  ', 'AB3XY7K2PQ'],
    ['AB3XY-7K2PQ', 'AB3XY7K2PQ'],
    ['AB3 XY7 K2P Q', 'AB3XY7K2PQ'],
    ['https://passthrough.dev/v/AB3XY7K2PQ', 'AB3XY7K2PQ'],
    ['passthrough.dev/v/ab3xy7k2pq', 'AB3XY7K2PQ'],
    ['https://staging.example.pages.dev/v/AB3XY7K2PQ?utm_source=li#top', 'AB3XY7K2PQ'],
    ['[![Passthrough badge](https://api.x/api/verify/AB3XY7K2PQ/badge.svg)](https://passthrough.dev/v/AB3XY7K2PQ)', 'AB3XY7K2PQ'],
    ['AB3XY7', 'AB3XY7'],                                  // a page issued before codes grew to 10 characters
    ['https://passthrough.dev/v/AB3XY7', 'AB3XY7'],
  ])('%s -> %s', (input, expected) => {
    expect(extractVerificationCode(input)).toBe(expected)
  })

  it.each([
    [''], ['   '], [null], [undefined],
    ['AB3XY'],                    // too short
    ['AB3XY7K'],                  // 7 is neither 6 nor 10
    ['AB3XY7K2PQR'],              // too long
    ['AB3XY7K2P0'],              // 0 is not in the alphabet
    ['AB3XY7K2PI'],              // nor is I
    ['https://passthrough.dev/pricing'],
    ['https://passthrough.dev/v/'],
    ['hello world'],
  ])('rejects %j', input => {
    expect(extractVerificationCode(input)).toBeNull()
  })

  it('never throws on a malformed percent-escape', () => {
    expect(() => extractVerificationCode('https://passthrough.dev/v/%E0%A4%A')).not.toThrow()
    expect(extractVerificationCode('https://passthrough.dev/v/%E0%A4%A')).toBeNull()
  })
})
