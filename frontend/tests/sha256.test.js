// @vitest-environment node
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { sha256Text } from '../src/lib/sha256'

const ref = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// The homepage tamper demo shows these hashes next to a "Passthrough Verified" ticket, so a wrong digit would
// be a visibly false demo of the one thing the product claims. Checked against Node's own implementation.
describe('sha256Text', () => {
  it('matches the published test vectors', () => {
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('is right at every padding boundary (55/56/63/64/65 bytes) and across many blocks', () => {
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 10_000]) expect(sha256Text('x'.repeat(n)), `${n} bytes`).toBe(ref('x'.repeat(n)))
  })
  it('hashes UTF-8, not UTF-16 (accents, CJK, emoji)', () => {
    for (const s of ['é', 'Zoë Müller', '履歴書', 'résumé 📄 ✓']) expect(sha256Text(s), s).toBe(ref(s))
  })
  it('the demo line and its one-character edit differ in the fingerprint', () => {
    const a = 'Led the roadmap for 3 squads; ran 14 A/B tests that lifted checkout conversion by 12%.'
    expect(sha256Text(a)).toBe(ref(a))
    expect(sha256Text(a.replace('12%', '19%'))).not.toBe(sha256Text(a))
  })
  it('coerces non-strings instead of throwing', () => {
    expect(sha256Text(undefined)).toBe(ref('undefined'))
    expect(sha256Text(12)).toBe(ref('12'))
  })
})
