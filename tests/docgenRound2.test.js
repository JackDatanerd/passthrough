// Second independent pass on prompts + documents: school-year dates, jobs that carry education words, multi-range roles, the skill
// invention guard, and scope/context inflation.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { canonDates } = require('../src/lib/dateFormat')
const { yearsFromText, careerFacts } = require('../src/lib/careerFacts')
const { scopeProblems, findClaimProblems } = require('../src/lib/claimGuard')
const { unsupportedSkills } = require('../src/services/claude.service')
const { REWRITE_SYSTEM } = require('../src/services/claude.service')
const NOW = new Date('2026-10-22T12:00:00Z')

describe('a bare YYYY-YY is a school year, never a month', () => {
  it.each([['2008-09', '2008 – 2009'], ['2010-11', '2010 – 2011'], ['2011-12', '2011 – 2012']])('%j -> %j', (a, b) => expect(canonDates(a)).toBe(b))
  it('reads ISO months only between two months', () => {
    expect(canonDates('2020-01 – 2022-06')).toBe('Jan 2020 – Jun 2022')
    expect(canonDates('2020-01 to Present')).toBe('Jan 2020 – Present')
    expect(canonDates('Jan 2020 - 2021-03')).toBe('Jan 2020 – Mar 2021')
    expect(canonDates('2019 – 2020-06')).toBe('2019 – 2020-06')
  })
  it('years are not read as a month either', () => {
    expect(careerFacts({ experience: [{ dates: '2008-09' }] }, NOW).years).toBe(1)
    expect(yearsFromText('Analyst 2019-06 to 2022-08', NOW)).toBe(3)
  })
})

describe('years from text: a job is not education because its title or employer says so', () => {
  it.each([
    ['Scrum Master — Acme Ltd\tJan 2019 – Dec 2022', 4], ['Graduate Engineer — Acme\tJan 2019 – Dec 2021', 3],
    ['Lecturer — University of Leeds\tJan 2018 – Present', 8], ['Teacher — Lincoln High School\t2015 – 2020', 5],
    ['Quality Engineer — Degree Controls Ltd\t2015 – 2020', 5],
  ])('%j -> %i', (t, y) => expect(yearsFromText(t, NOW)).toBe(y))
  it('still skips education entries, by heading and by degree word', () => {
    expect(yearsFromText('EXPERIENCE\nAnalyst — Acme\tJan 2019 – Dec 2021\nEDUCATION\nUniversity of Leeds\t2012 – 2016\nSKILLS\nSQL', NOW)).toBe(3)
    expect(yearsFromText('BSc Statistics 2012 – 2016', NOW)).toBeNull()
    expect(yearsFromText('University of Leeds 2012 – 2016', NOW)).toBeNull()
    expect(yearsFromText('Lincoln High School 2008 – 2012', NOW)).toBeNull()
  })
  it('counts every range a single role lists', () => {
    expect(careerFacts({ experience: [{ dates: 'Jan 2019 – Jun 2020; Mar 2021 – Present' }] }, NOW).years).toBe(7)
  })
})

describe('a skill is supported only when the resume supports every word it adds', () => {
  const orig = { summary: 'Python developer', experience: [{ company: 'A', title: 'Dev', bullets: ['Built APIs in Python, used MS Excel weekly, managed projects.', 'Wrote Postgres queries.'] }], skills: ['Python', 'Excel', 'SQL', 'React', 'Management'] }
  it.each(['Python Django', 'Advanced Excel VBA', 'SQL Server', 'React Native', 'AWS Lambda', 'Kubernetes'])('rejects %s', sk => expect(unsupportedSkills(orig, { skills: [sk] })).toEqual([sk]))
  it.each(['Python', 'Advanced Excel', 'Microsoft Excel', 'PostgreSQL', 'Project Management'])('accepts %s', sk => expect(unsupportedSkills(orig, { skills: [sk] })).toEqual([]))
})

describe('scope and context the person never described', () => {
  const src = 'Analyst\nHandled customer escalations for the billing team.\nWorked with stakeholders on monthly compliance reports.'
  it.each(['high-volume', 'across multiple regions', 'team lead', 'senior leadership', 'complex', 'cross-functional', 'mentored', 'senior stakeholders', 'driving customer satisfaction'])('flags %s', phrase => {
    const line = { 'high-volume': 'Handled high-volume escalations.', 'across multiple regions': 'Handled escalations across multiple regions.', 'team lead': 'Handled escalations as team lead.', 'senior leadership': 'Briefed senior leadership on escalations.', complex: 'Handled complex escalations.', 'cross-functional': 'Handled escalations in a cross-functional team.', mentored: 'Mentored new hires on escalations.', 'senior stakeholders': 'Reported to senior stakeholders.', 'driving customer satisfaction': 'Handled escalations, driving customer satisfaction.' }[phrase]
    expect(scopeProblems(line, src)).toContain(phrase === 'driving customer satisfaction' ? 'driving customer satisfaction' : phrase)
  })
  it('lets through what the person wrote, in their own words', () => {
    expect(scopeProblems('Produced monthly compliance reports with key stakeholders.', src)).toEqual([])
    expect(scopeProblems('Mentored interns.', 'Mentoring interns weekly')).toEqual([])
    expect(scopeProblems('Supported the billing team with customer escalations.', src)).toEqual([])
  })
  it('is a hard claim problem in the rewrite guard, and "complex" is not "compliance"', () => {
    const orig = { experience: [{ company: 'Acme', title: 'Analyst', bullets: ['Handled customer escalations for the billing team.', 'Worked with stakeholders on monthly compliance reports.'] }] }
    const out = { experience: [{ company: 'Acme', title: 'Analyst', bullets: ['Handled high-volume escalations for the billing team.'] }] }
    expect(findClaimProblems(orig, out, { source: src, renames: [] }).join(' ')).toMatch(/high-volume/)
    expect(scopeProblems('Handled complex escalations.', src)).toEqual(['complex'])
  })
  it('the prompt states the rule', () => expect(REWRITE_SYSTEM).toMatch(/Never add a setting, scale or audience/))
})
