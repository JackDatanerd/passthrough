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

describe('groundQuantificationPrompts — identical lines under different jobs stay separate prompts', () => {
  const resume = { experience: [
    { company: 'Acme', bullets: ['Managed vendor relationships across the region for the team'] },
    { company: 'Globex', bullets: ['Managed vendor relationships across the region for the team'] },
  ] }
  it('keeps one prompt per position and tells them apart', () => {
    const out = claude.groundQuantificationPrompts(resume, [{ job: 1, bullet: 0, suggestion: 'how many?' }, { job: 1, bullet: 0, suggestion: 'again' }])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ jobIndex: 1, bulletIndex: 0 })
    const both = claude.groundQuantificationPrompts(resume, [{ job: 0, bullet: 0, suggestion: 'a' }, { job: 1, bullet: 0, suggestion: 'b' }])
    expect(both.map(q => [q.jobIndex, q.bulletIndex])).toEqual([[0, 0], [1, 0]])
  })
  it('a text-form prompt is anchored to the real position it matched', () => {
    const out = claude.groundQuantificationPrompts(resume, [{ bullet: 'Managed vendor relationships across the region for the team', suggestion: 'x' }])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ jobIndex: 0, bulletIndex: 0 })
  })
  it('the fallback prompts carry their position too', () => {
    expect(claude.fallbackQuantificationPrompts(resume).map(q => [q.jobIndex, q.bulletIndex])).toEqual([[0, 0], [1, 0]])
  })
})
