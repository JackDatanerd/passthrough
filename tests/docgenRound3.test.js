// Third independent pass on prompts + documents: letter scope guard, education-block end, Letter-paper squeeze, skill tidy-ups, scope stems.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { yearsFromText } = require('../src/lib/careerFacts')
const { scopeProblems } = require('../src/lib/claimGuard')
const { densityFor, estimateLoad, capacityFor } = require('../src/lib/docFit')
const cs = require('../src/services/claude.service')
const NOW = new Date('2026-10-22T12:00:00Z')

describe('the cover letter is held to the same scope rule as the resume', () => {
  const resumeData = { name: 'Emily Carter', summary: null, experience: [{ company: 'Acme', title: 'Analyst', dates: 'Jan 2022 – Present', bullets: ['Handled customer escalations for the billing team.', 'Built weekly reports in Power BI.'] }], education: [], skills: ['Power BI'] }
  const corpus = 'Emily Carter Acme Analyst Handled customer escalations for the billing team. Built weekly reports in Power BI. Billing analyst for our fast-paced regulated team.'
  const run = body => cs.checkLetter(`Dear Hiring Manager,\n\n${body}\n\nSincerely,\nEmily Carter`, { resumeData, jdText: 'Billing analyst for our fast-paced regulated team.', details: {}, allowedNumbers: new Set(), facts: { years: 4 }, haveNumbers: new Set(), corpus })
  it('passes an honest letter', () => expect(run('At Acme I handle customer escalations for the billing team and build weekly reports in Power BI.')).toEqual({ hard: [], soft: [] }))
  it.each([
    'At Acme I handled high-volume escalations across multiple regions for senior leadership.',
    'At Acme I mentored new analysts as team lead.',
  ])('rejects invented scope: %s', b => expect(run(b).hard.join(' ')).toMatch(/setting, scale or role/))
  it('only advises on a phrase the posting itself uses, and never judges a plan for the future', () => {
    // Adjectives like fast-paced / regulated are not judged in a letter (round 4); a scale or audience the posting uses is advice only.
    expect(run('I handled escalations in a fast-paced, regulated setting like your team.')).toEqual({ hard: [], soft: [] })
    const echo = run('I reported to the board every month on billing escalations.')
    expect(echo.hard.join(' ')).toMatch(/setting, scale or role/)
    expect(run('In my first months I would mentor your analysts and help the cross-functional team.')).toEqual({ hard: [], soft: [] })
  })
})

describe('an education block ends at any other heading', () => {
  const mk = h => `EDUCATION\nBSc Statistics — University of Leeds\t2012 – 2016\nUNIVERSITY OF LEEDS\t2012 – 2016\n${h}\nAnalyst — Acme\tJan 2018 – Dec 2022`
  it.each(['WORK EXPERIENCE', 'PROFESSIONAL BACKGROUND', 'RELEVANT WORK EXPERIENCE', 'TEACHING EXPERIENCE', 'INTERNSHIPS', 'EXPERIENCE & PROJECTS', 'Industry Experience', 'Career Highlights'])('%s', h => expect(yearsFromText(mk(h), NOW)).toBe(5))
  it('an all-caps school line is still an entry', () => expect(yearsFromText('EDUCATION\nUNIVERSITY OF LEEDS\n2012 – 2016\nBSc', NOW)).toBeNull())
})

describe('Letter-paper DOCX compacts as far as it can really absorb', () => {
  const B = ['Cut weekly reporting from 6 hours to 1 by automating 14 SQL dashboards in Power BI for the finance and operations teams.', 'Built a churn model in Python that flagged 12% of at-risk accounts two months earlier than the previous manual process.', 'Reconciled 40,000 monthly transactions across 5 systems, reducing exceptions by 30% and closing the month two days sooner.', 'Produced the monthly board KPI pack used by 9 executives and cut preparation time by half.', 'Ran sprint ceremonies for two squads of 8 engineers.', 'Mentored 3 junior analysts on SQL review.']
  // The resume the page counts were measured on (4 jobs, n bullets spread over them, rendered through LibreOffice with Calibri-metric Carlito).
  const mk = n => ({ name: 'Emily Carter', email: 'emily.carter@example.com', phone: '+1 700 123 456', location: 'Austin, TX', linkedin: 'linkedin.com/in/emily-carter',
    summary: 'Data analyst with 6+ years turning messy operational data into reporting that finance and operations teams act on. Strongest in SQL, Python and Power BI.',
    experience: [0, 1, 2, 3].map(i => ({ title: 'Senior Data Analyst', company: 'Company ' + i, location: 'Austin', dates: `Jan ${2025 - i * 2} – Dec ${2026 - i * 2}`, bullets: Array.from({ length: Math.floor(n / 4) + (i < n % 4 ? 1 : 0) }, (_, j) => B[j % 6]) })),
    education: [{ degree: 'BSc Statistics', institution: 'University of Leeds', dates: '2012 – 2016', details: null }], skills: ['SQL', 'Python', 'Power BI', 'Excel', 'Tableau'], certifications: ['Google Data Analytics Certificate'], languages: ['English', 'Swahili'] })
  it('15 to 18 bullets (9-15% over capacity) were measured to fit one page compact; the estimator now picks compact', () => {
    for (const n of [15, 16, 17, 18]) {
      const r = estimateLoad(mk(n), 1) / capacityFor('letter', 'docx')
      expect(r).toBeGreaterThan(1.08); expect(r).toBeLessThanOrEqual(1.15)
      expect(densityFor(mk(n), 'letter', 'docx')).toBe('compact')
    }
  })
  it('A4 keeps its measured limit; a clearly longer Letter resume stays normal', () => {
    expect(densityFor(mk(19), 'a4', 'docx')).toBe('normal')
    expect(densityFor(mk(19), 'letter', 'docx')).toBe('normal')   // 1.165: measured to spill even compact
  })
})

describe('the skill guard accepts honest tidy-ups and still rejects products the person never named', () => {
  const t = (sk, out) => cs.unsupportedSkills({ summary: null, experience: [{ company: 'A', title: 'X', bullets: ['Did work.'] }], skills: [sk] }, { skills: [out] })
  it.each([['Budgeting', 'Budget Management'], ['Photoshop', 'Adobe Photoshop'], ['Illustrator', 'Adobe Illustrator'], ['Bookkeeping', 'Book-keeping'], ['Excel', 'Microsoft Excel']])('%s -> %s', (a, b) => expect(t(a, b)).toEqual([]))
  it.each([['Analytics', 'Google Analytics'], ['CAD', 'AutoCAD'], ['Python', 'Python 3'], ['SQL', 'MySQL'], ['Python', 'Python Django'], ['Photoshop', 'Adobe Illustrator']])('%s -> %s is rejected', (a, b) => expect(t(a, b)).toEqual([b]))
})

describe('scope words match across endings', () => {
  it('"Coached" for "Coaching", "board of directors" for "the board"; "complex" is still not "compliance"', () => {
    expect(scopeProblems('Coached junior staff.', 'Coaching junior staff')).toEqual([])
    expect(scopeProblems('Reported to the CEO and board of directors.', 'Reported to the CEO and the board')).toEqual([])
    expect(scopeProblems('Complex tax filings.', 'compliance filings')).toEqual(['complex'])
  })
})
