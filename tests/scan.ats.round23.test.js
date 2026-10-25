// Scan / ATS round 23: degree-level abbreviations in the fabrication guard, decade-style tenure claims, and degree lines in
// yearsFromText.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const claude = require('../src/services/claude.service.js')
const cf = require('../src/lib/careerFacts.js')

const mk = (degree, dates = '2011 - 2015') => ({
  name: 'Jane', experience: [{ company: 'Acme', title: 'Engineer', dates: '2019 - Present', bullets: ['Built things'] }],
  education: [{ institution: 'State University', degree, dates, details: null }], skills: [], certifications: [], projects: [],
})

describe('B10 - an honest expansion of a degree abbreviation is not a fabricated degree', () => {
  it.each([
    ['BBA', 'Bachelor of Business Administration'], ['BCom', 'Bachelor of Commerce'], ['B.Com', 'Bachelor of Commerce'], ['LLB', 'Bachelor of Laws'],
    ['BEd', 'Bachelor of Education'], ['BCA', 'Bachelor of Computer Applications'], ['BPharm', 'Bachelor of Pharmacy'], ['BSN', 'Bachelor of Science in Nursing'],
    ['BFA', 'Bachelor of Fine Arts'], ['BArch', 'Bachelor of Architecture'], ['BIT', 'Bachelor of Information Technology'], ['BE', 'Bachelor of Engineering'],
    ['MPhil', 'Master of Philosophy'], ['MPH', 'Master of Public Health'], ['MEd', 'Master of Education'], ['MFA', 'Master of Fine Arts'],
    ['LLM', 'Master of Laws'], ['MRes', 'Master of Research'], ['MCom', 'Master of Commerce'], ['MSW', 'Master of Social Work'],
    ['EdD', 'Doctor of Education'], ['DBA', 'Doctor of Business Administration'], ['DPhil', 'Doctor of Philosophy'],
    ['HND', 'Higher National Diploma'], ['PGDip', 'Postgraduate Diploma'], ['BSc', 'Bachelor of Science'], ['MSc', 'Master of Science'],
    ['Bachelor of Commerce', 'BCom'], ['Bachelor of Laws', 'LLB'],
  ])('%s -> %s', (o, n) => { expect(claude.detectFabrication(mk(o), mk(n))).toBe(false) })

  it.each([
    ['BCom', 'Master of Commerce'], ['BSc', 'MSc'], ['BBA', 'MBA'], ['LLB', 'LLM'], ['BEd', 'MEd'], ['HND', 'Bachelor of Science'],
    ['MPhil', 'PhD'], ['Diploma in IT', 'Bachelor of IT'], ['MSc', 'PhD'], ['BSc', 'Doctor of Philosophy'],
  ])('a real upgrade %s -> %s is still caught', (o, n) => { expect(claude.detectFabrication(mk(o), mk(n))).toBe(true) })

  it('ordinary English words are not read as degrees', () => {
    expect(claude.detectFabrication(mk('Certificate, to be awarded 2015'), mk('Certificate, to be awarded 2015'))).toBe(false)
    expect(claude.detectFabrication(mk('Certificate in Marketing (March intake)'), mk('Certificate in Marketing'))).toBe(false)
  })
})

describe('B11 - a decade-style tenure claim is read as the years it stands for', () => {
  it.each([
    ['over a decade of experience', [10]], ['a decade in operations', [10]], ['two decades of experience', [20]], ['2 decades', [20]],
    ['3 decades of experience', [30]], ['half a decade of experience', [5]], ['a quarter-century of experience', [25]], ['a decade-long career', [10]],
    ['decades of experience', [20]], ['spent a decade leading ops', [10]], ['several decades in finance', [20]],
  ])('%s', (t, want) => { expect(cf.tenureClaims(t)).toEqual(want) })

  it.each([
    'over the past decade the industry changed', 'a decade ago I started', 'in the last decade, your team grew', 'this decade will be about AI',
    'a decade of growth at your company', 'the decade-long partnership you describe',
  ])('not a claim about the person: %s', t => { expect(cf.tenureClaims(t)).toEqual([]) })

  it('the existing digit / spelled-year phrasing is unchanged', () => {
    expect(cf.tenureClaims('5+ years')).toEqual([5])
    expect(cf.tenureClaims('ten-plus years')).toEqual([10])
    expect(cf.tenureClaims('3-5 years of experience')).toEqual([3, 5])
  })
  it('a decade echoed from the posting is not the applicant\'s claim', () => {
    const posting = new Set(cf.tenureClaims('We want a decade of experience'))
    expect(cf.tenureClaims('Your posting asks for a decade of experience', { posting })).toEqual([])
    expect(cf.tenureClaims('I bring a decade of experience', { posting })).toEqual([10])
  })
  it('blanks the phrase so the generic figure check does not see it twice, but keeps non-claims', () => {
    expect(cf.withoutTenureClaims('I spent two decades leading ops')).not.toMatch(/two/)
    expect(cf.withoutTenureClaims('over the past decade')).toContain('decade')
  })
  it('the summary guard rejects an inflated decade claim and accepts an honest one', () => {
    const orig = { name: 'Jane', experience: [{ company: 'Acme', title: 'Analyst', dates: '2023 - Present', bullets: ['Built reports'] }], education: [], skills: ['Excel'], projects: [], certifications: [] }
    const bad = s => claude.inventedNumbers(orig, { ...orig, summary: s })
    expect(bad('Analyst with over a decade of experience building reports.')).toContain(10)
    expect(bad('Analyst with two decades of experience.').length).toBeGreaterThan(0)
    expect(bad('Analyst with 3 years of experience.')).toEqual([])
    const veteran = { ...orig, experience: [{ company: 'Acme', title: 'Analyst', dates: '2010 - Present', bullets: ['Built reports'] }] }
    expect(claude.inventedNumbers(veteran, { ...veteran, summary: 'Analyst with over a decade of experience.' })).toEqual([])
  })
})

describe('B11b - a degree line is education, not work years', () => {
  it.each(['BCom 2011 - 2015', 'LLB 2008 - 2012', 'MPhil 2016 - 2018', 'HND 2009 - 2011', 'BBA 2010 - 2014'])('%s', line => {
    expect(cf.yearsFromText(`Experience\nAnalyst, Acme 2019 - 2021\n${line}`)).toBe(2)
  })
  it('a job line that happens to contain "bed" is still work', () => { expect(cf.yearsFromText('Nurse, Managed 40-bed ward 2018 - 2020')).toBe(2) })
})

describe('B12 - a bullet returned as one string is one bullet, not comma fragments', () => {
  const shape = bullets => claude.sanitizeResumeShape({ experience: [{ company: 'Acme', title: 'Analyst', dates: '2020 - 2022', bullets }] }).experience[0].bullets
  it('keeps a comma / currency sentence whole', () => {
    expect(shape('Cut reporting time by 40%, saving the team $1,200 a month')).toEqual(['Cut reporting time by 40%, saving the team $1,200 a month'])
  })
  it('still splits on line breaks and bullet glyphs, and strips list markers', () => {
    expect(shape('- First\n- Second\n\u2022 Third')).toEqual(['First', 'Second', 'Third'])
  })
  it('an array is untouched (commas inside an item stay)', () => { expect(shape(['x, y', 'z'])).toEqual(['x, y', 'z']) })
  it('volunteer bullets follow the same rule; a skills string is still a comma list', () => {
    const r = claude.sanitizeResumeShape({ volunteer: [{ organization: 'Red Cross', role: 'Volunteer', dates: '2019', bullets: 'Organised drives, raised funds' }], skills: 'Python, SQL' })
    expect(r.volunteer[0].bullets).toEqual(['Organised drives, raised funds'])
    expect(r.skills).toEqual(['Python', 'SQL'])
  })
})
