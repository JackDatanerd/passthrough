import { describe, it, expect } from 'vitest'
const ats = require('../src/services/ats.service')
const docx = require('../src/services/docx.service')
const parser = require('../src/services/resume.parser')
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const JD = 'Senior Backend Engineer\nRequirements\n- 5+ years Node.js, PostgreSQL, AWS\n'

describe('R22: whitespace runs cannot make scoring slow', () => {
  it('a 24,000-space resume scores in well under a second', () => {
    const t = Date.now()
    ats.scoreResume(' '.repeat(24000), JD)
    expect(Date.now() - t).toBeLessThan(1000)
  })
  it('a space run in the middle of a real line is capped, not quadratic', () => {
    const t = Date.now()
    ats.scoreResume('Backend engineer. ' + ' '.repeat(20000) + 'Node.js AWS.\nExperience\n- Built APIs 30%\n', JD)
    expect(Date.now() - t).toBeLessThan(1000)
  })
  it('tab runs and a padded job description are capped too', () => {
    const t = Date.now()
    ats.scoreResume('x\n' + '\t'.repeat(24000) + 'Go', JD + ' '.repeat(5000))
    expect(Date.now() - t).toBeLessThan(1000)
  })
  it('normalizeTechTerms on a long run is fast, and Go still resolves as the language', () => {
    const t = Date.now()
    ats.normalizeTechTerms(' '.repeat(24000))
    expect(Date.now() - t).toBeLessThan(500)
    expect(ats.normalizeTechTerms('Experience with Go and Python')).toMatch(/golang/)
    expect(ats.normalizeTechTerms('strong  Go skills')).toMatch(/golang/)
  })
  it('capSpaceRuns leaves ordinary gaps alone', () => {
    expect(ats.capSpaceRuns('a   b\t\tc' + ' '.repeat(40) + 'd')).toBe('a   b\t\tc' + ' '.repeat(40) + 'd')
    expect(ats.capSpaceRuns('a' + ' '.repeat(41) + 'b')).toBe('a' + ' '.repeat(40) + 'b')
  })
})

describe('R22: role signals', () => {
  it('a financial controller is finance', () => {
    expect(ats.detectRoleCategory('Financial Controller\nWe are hiring.')).toBe('finance')
    expect(ats.detectRoleCategory('Payroll Specialist\nWe are hiring.')).toBe('finance')
  })
})

describe('R22: summary line breaks survive into the .docx as paragraphs', () => {
  it('each line is its own paragraph and the text still extracts line by line', async () => {
    const bytes = await docx.generateAtsDocx({ name: 'Ann Lee', email: 'a@b.co', summary: 'Line one.\nLine two.\n\nLine three.', experience: [{ title: 'Eng', company: 'X', dates: '2020', bullets: ['Built APIs'] }] }, null, {})
    const text = await parser.extractText(new Uint8Array(bytes), MIME)
    expect(text).toContain('Line one.\nLine two.\nLine three.')
  })
})
