import { describe, it, expect } from 'vitest'
import { deriveJobTitle } from '../src/lib/jobTitle.js'

describe('deriveJobTitle', () => {
  it('takes the first line when it looks like a title', () => {
    expect(deriveJobTitle('Senior Backend Engineer\nAcme Corp\nWe are hiring...')).toBe('Senior Backend Engineer')
  })
  it('strips a "Job Title:" style label and markdown decoration', () => {
    expect(deriveJobTitle('Job Title: Data Analyst')).toBe('Data Analyst')
    expect(deriveJobTitle('## **Product Designer**')).toBe('Product Designer')
    expect(deriveJobTitle('Position - Sales Lead')).toBe('Sales Lead')
  })
  it('skips section headings and company blurbs to reach the title', () => {
    expect(deriveJobTitle('About the job\nJob Description\nStaff Accountant\nDetails follow')).toBe('Staff Accountant')
    expect(deriveJobTitle('About us\nWho we are\nWe are a fast-growing startup on a mission.\nMarketing Manager')).toBe('Marketing Manager')
  })
  it('skips blank lines and control characters', () => {
    expect(deriveJobTitle('\n\n  \u200b \nQA Engineer\n')).toBe('QA Engineer')
  })
  it('skips overlong lines and full sentences', () => {
    expect(deriveJobTitle('x'.repeat(101) + '\nEditor')).toBe('Editor')
    expect(deriveJobTitle('We are looking for a motivated and detail oriented person to join us.\nOffice Manager')).toBe('Office Manager')
  })
  it('returns null when nothing title-shaped is near the top, or for empty input', () => {
    expect(deriveJobTitle('')).toBeNull()
    expect(deriveJobTitle(null)).toBeNull()
    expect(deriveJobTitle('ab\n\n  \nAbout us')).toBeNull()
    expect(deriveJobTitle('a\n'.repeat(30) + 'Real Title')).toBeNull()   // only the first few lines are considered
  })
  it('never returns markup-active content as anything but plain text (callers render it as text)', () => {
    expect(deriveJobTitle('<script>alert(1)</script> Engineer')).toBe('<script>alert(1)</script> Engineer')
  })
})
