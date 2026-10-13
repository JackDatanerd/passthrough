import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { extractSha256 } from '../../src/lib/fileFingerprint'

// Round-11: no regex lookbehind (Safari < 16.4 cannot compile it), and the same answers as before.
const H = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
const G = 'ff'.repeat(32)

describe('extractSha256 without lookbehind', () => {
  it('the source contains no lookbehind assertion', () => {
    const src = fs.readFileSync(new URL('../../src/lib/fileFingerprint.js', import.meta.url), 'utf8')
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/\(\?<[!=]/)
  })
  it.each([
    ['bare', H], ['upper-case', H.toUpperCase()], ['shasum line', `${H}  resume.pdf`], ['SHA256: prefix', `SHA256:${H}`],
    ['certutil block', `SHA256 hash of resume.docx:\n${H}\nCertUtil: -hashfile command completed successfully.`],
    ['at the very start and end of the text', `${H}`], ['preceded by a non-hex word', `hash=${H}`],
  ])('finds one hash: %s', (_n, text) => { expect(extractSha256(text)).toBe(H) })
  it('accepts the older certutil spacing and colon-separated bytes', () => {
    const pairs = H.match(/../g)
    expect(extractSha256(pairs.join(' '))).toBe(H)
    expect(extractSha256(pairs.join(':').toUpperCase())).toBe(H)
  })
  it('the same hash twice is one hash; two different hashes are refused', () => {
    expect(extractSha256(`${H}\n${H}`)).toBe(H)
    expect(extractSha256(`${H}\n${G}`)).toBeNull()
    expect(extractSha256(`${H},${G}`)).toBeNull()
    expect(extractSha256(`${H} ${G}`)).toBeNull()
  })
  it('refuses a hash buried in a longer hex run (SHA-512, 65+ digits) and non-hashes', () => {
    expect(extractSha256(H + H)).toBeNull()
    expect(extractSha256(`${H}a`)).toBeNull()
    expect(extractSha256(`a${H}`)).toBeNull()
    expect(extractSha256('')).toBeNull()
    expect(extractSha256(null)).toBeNull()
    expect(extractSha256('not a fingerprint')).toBeNull()
  })
})
