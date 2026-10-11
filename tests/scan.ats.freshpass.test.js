import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const claude = require('../src/services/claude.service')

describe('sanitizeGeneratedHtml — request-triggering attributes the strip list used to miss', () => {
  it('removes imagesrcset (and keeps the allowlisted font link itself)', () => {
    const html = '<html><head><link rel="preload" as="image" href="https://fonts.googleapis.com/css2?family=Inter" imagesrcset="http://169.254.169.254/latest/meta-data/ 1x" imagesizes="100vw"></head><body>x</body></html>'
    const out = claude.sanitizeGeneratedHtml(html)
    expect(out).not.toMatch(/imagesrcset/i)
    expect(out).not.toMatch(/169\.254/)
    expect(out).toContain('fonts.googleapis.com')
  })
})

describe('groundQuantificationPrompts — every prompt must point at a real bullet', () => {
  const resume = { experience: [
    { company: 'Acme', bullets: ['Built the billing API used by customers across three regions', 'Led weekly planning for the platform team'] },
    { company: 'Globex', bullets: ['Reduced reporting time for finance'] },
  ] }
  it('keeps exact matches, snaps near-verbatim ones to the real text, drops invented ones, dedupes', () => {
    const out = claude.groundQuantificationPrompts(resume, [
      { bullet: 'Led weekly planning for the platform team', suggestion: 'team size?' },
      { bullet: 'built the billing API used by customers across 3 regions.', suggestion: 'volume?' },
      { bullet: 'Led weekly planning for the platform team ', suggestion: 'duplicate' },
      { bullet: 'Shipped a mobile app to ten thousand users', suggestion: 'not in the resume' },
      { bullet: 123, suggestion: 'bad type' },
      null,
    ])
    expect(out.map(q => q.bullet)).toEqual([
      'Led weekly planning for the platform team',
      'Built the billing API used by customers across three regions',
    ])
    expect(out[1].suggestion).toBe('volume?')
  })
  it('is empty for a non-array or a resume with no experience', () => {
    expect(claude.groundQuantificationPrompts(resume, null)).toEqual([])
    expect(claude.groundQuantificationPrompts({}, [{ bullet: 'x', suggestion: 'y' }])).toEqual([])
  })
})
