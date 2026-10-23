// Fourth independent pass: the letter is judged only on claims about the person's own past, an all-caps education sub-line is not a
// heading, and "40k" / "40,000" are one figure.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { yearsFromText } = require('../src/lib/careerFacts')
const { scopeProblems } = require('../src/lib/claimGuard')
const { findProvenanceProblems } = require('../src/lib/rewriteStyle')
const cs = require('../src/services/claude.service')
const NOW = new Date('2026-10-22T12:00:00Z')

describe('cover letter: employer praise and the applicant\'s own tastes are not fabrication', () => {
  const resumeData = { name: 'Wanjiru Mwangi', summary: null, experience: [{ company: 'Acme', title: 'Analyst', dates: 'Jan 2022 – Present', bullets: ['Handled customer escalations for the billing team.', 'Built weekly reports in Power BI.'] }], education: [], skills: ['Power BI'] }
  const corpus = 'Wanjiru Mwangi Acme Analyst Handled customer escalations for the billing team. Built weekly reports in Power BI. Billing analyst. Power BI.'
  const run = body => cs.checkLetter(`Dear Hiring Manager,\n\n${body}\n\nSincerely,\nWanjiru Mwangi`, { resumeData, jdText: 'Billing analyst. Power BI.', details: {}, allowedNumbers: new Set(), facts: { years: 4 }, haveNumbers: new Set(), corpus })
  it.each([
    'Your cutting-edge billing platform is exactly what I want to work on.', 'I enjoy solving complex problems with data.',
    'I am comfortable working in a fast-paced environment.', 'I handle compliance questions from customers on the billing team.',
    'I am drawn to the global reach of your team.', 'In my first months I would mentor your analysts.',
  ])('passes: %s', b => expect(run(b)).toEqual({ hard: [], soft: [] }))
  it('a mentoring claim about the person is advice, not a rejection', () => {
    const r = run('I take pride in mentoring newer teammates.'); expect(r.hard).toEqual([]); expect(r.soft.join(' ')).toMatch(/mentoring/)
  })
  it.each([
    'At Acme I handled high-volume escalations across multiple regions for senior leadership.', 'At Acme I worked as team lead on billing escalations.',
  ])('still rejects an invented scale, audience or role: %s', b => { const r = run(b); expect(r.hard.join(' ')).toMatch(/setting, scale or role/) })
  it('the resume guard still judges every family', () => {
    expect(scopeProblems('Handled complex escalations.', 'Handled escalations')).toEqual(['complex'])
    expect(scopeProblems('Handled complex escalations.', 'Handled escalations', ['core'])).toEqual([])
  })
})

describe('an all-caps education sub-line is not a heading', () => {
  it.each([
    ['EDUCATION\nUNIVERSITY OF NAIROBI\nSTATISTICS AND ACTUARIAL SCIENCE\n2012 – 2016', null],
    ['EDUCATION\nKENYA CERTIFICATE OF SECONDARY EDUCATION\nSTARE HIGH\n2008 – 2012', null],
    ['EDUCATION\nBSc Statistics\nFIRST CLASS HONOURS\n2012 – 2016', null],
    ['EXPERIENCE\nAnalyst — Acme\tJan 2018 – Dec 2022\nEDUCATION\nSTATISTICS\n2012 – 2016', 5],
  ])('%j -> %s', (t, y) => expect(yearsFromText(t, NOW)).toBe(y))
  it('an all-caps heading before a job still ends the block', () => {
    expect(yearsFromText('EDUCATION\nBSc — UoN\t2012 – 2016\nPROFESSIONAL BACKGROUND\nAnalyst — Acme\tJan 2018 – Dec 2022', NOW)).toBe(5)
    expect(yearsFromText('EDUCATION\nBSc — UoN\t2012 – 2016\nINTERNSHIPS\nIntern — Acme\tJan 2018 – Dec 2019', NOW)).toBe(2)
  })
})

describe('provenance reads "40k" and "40,000" as one figure', () => {
  const input = { experience: [{ bullets: ['Saved KES 40k monthly on vendor costs', 'Cut costs 1.2m yearly', 'Grew sales 15%'] }] }
  const check = (i, b) => findProvenanceProblems(input, { experience: [{ bullets: [b] }] }, [{ job: 0, bullet: 0, from: [i] }])
  it.each([[0, 'Saved KES 40,000 monthly.'], [0, 'Saved KES 40k monthly.'], [1, 'Cut costs by 1.2 million yearly.'], [1, 'Cut costs by 1,200,000 yearly.']])('%i %s is fine', (i, b) => expect(check(i, b)).toEqual([]))
  it.each([[0, 'Saved KES 50k monthly.'], [2, 'Grew sales 25%.']])('%i %s is still a stray figure', (i, b) => expect(check(i, b).join(' ')).toMatch(/not in the input bullets/))
})
