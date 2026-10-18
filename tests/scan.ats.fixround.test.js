import { describe, it, expect } from 'vitest'
import { numbersIn, inventedNumbers, detectFabrication } from '../src/services/claude.service.js'
import { detectSeniority, scoreResume } from '../src/services/ats.service.js'
import { stripPlatformBoilerplate } from '../src/services/jdBoilerplate.js'

const one = bullet => ({ name: 'A B', summary: '', experience: [{ company: 'Acme', title: 'Lead', dates: '2020-2022', bullets: [bullet] }], skills: [], education: [] })

describe('numbersIn: exact scaling (no binary float noise)', () => {
  it('reads $4.1M as exactly 4,100,000', () => {
    expect([...numbersIn('$4.1M')]).toEqual([4100000])
    expect([...numbersIn('4,100,000')]).toEqual([4100000])
  })
  it('every one- and two-decimal k / m / b figure equals its written-out integer', () => {
    for (const [suf, mult] of [['k', 1e3], ['m', 1e6], ['b', 1e9]])
      for (let i = 1; i <= 9999; i++) {
        const s = (i / 100).toString()
        if (!s.includes('.')) continue
        expect([...numbersIn(s + suf)][0]).toBe(Math.round((i * mult) / 100))
      }
  })
  it('plain numbers and the x multiplier are unchanged', () => {
    expect([...numbersIn('3x faster, 1,200 users, 99.9%')].sort((a, b) => a - b)).toEqual([3, 99.9, 1200])
  })
})

describe('fabrication guard: an honest abbreviation is not an invented number', () => {
  const pairs = [
    ['Grew pipeline to 4,100,000 dollars', 'Grew pipeline to $4.1M'],
    ['Managed an $8,300,000 budget', 'Managed an $8.3M budget'],
    ['Managed 65,100 accounts', 'Managed 65.1k accounts'],
    ['Raised $16.1k', 'Raised $16,100'],
    ['Supported 24x7 operations', 'Supported 24/7 operations'],
    ['Ran a 24-7 help desk', 'Ran a 24x7 help desk'],
  ]
  for (const [o, r] of pairs) it(`${o}  =>  ${r}`, () => {
    expect([...inventedNumbers(one(o), one(r))]).toEqual([])
    expect(detectFabrication(one(o), one(r))).toBe(false)
  })
  it('a genuinely new figure is still caught', () => {
    expect([...inventedNumbers(one('Grew pipeline to $4.1M'), one('Grew pipeline to $4.2M'))].length).toBe(1)
    expect([...inventedNumbers(one('Ran 24x7 support'), one('Ran 24/7 support for 40 clients'))]).toEqual([40])
  })
})

describe('detectSeniority reads the title area, not the first 200 characters of prose', () => {
  const cases = [
    ['Marketing Coordinator\nPrincipal responsibilities include managing our social channels and email campaigns.', 'mid'],
    ['Sales Development Representative\nYou will own lead generation and qualify inbound lead flow for the team.', 'mid'],
    ['Software Engineer\nAbout us: Acme is led by our CEO and a team of ex-Google engineers. We build APIs.', 'mid'],
    ['Data Analyst\nJoin the finance team under the Chief Financial Officer; you will build dashboards.', 'mid'],
    ['Customer Support Agent\nAre you a recent graduate or a seasoned pro? You will answer tickets.', 'mid'],
    ['Registered Nurse\nOur intern program feeds the unit. Staff nurse position, 12-hour shifts.', 'mid'],
    ['About the job\nAcme is hiring. You will be the lead on our payments team and mentor juniors.', 'mid'],
    // real titles still count
    ['Senior Software Engineer\nAbout us: we are small.', 'senior'],
    ['Job Description\nSenior Backend Engineer', 'senior'],
    ['Acme Corp\nJob title: Principal Engineer\nWe are hiring.', 'lead'],
    ['Principal Investigator, Oncology', 'lead'],
    ['Graduate Software Engineer', 'junior'],
    ['Data Analyst (graduate degree preferred)', 'mid'],
    ['Chief of Staff', 'executive'],
    ['Team Lead, Payments', 'lead'],
  ]
  for (const [jd, lvl] of cases) it(`${lvl}: ${jd.slice(0, 60).replace(/\n/g, ' / ')}`, () => expect(detectSeniority(jd)).toBe(lvl))
})

describe('scoreResume on a hostile long token', () => {
  it('stays fast on 24,000 characters with no spaces (the email check used to backtrack quadratically)', () => {
    const t0 = Date.now()
    const r = scoreResume('x'.repeat(24000), 'Software engineer with python and sql experience')
    expect(Number.isFinite(r.score)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
  })
  it('still finds a real email address', () => {
    const r = scoreResume('Jane Doe\njane.doe@example.com\n+1 555 123 4567\nExperience\nEducation\nSkills\n' + 'worked on things. '.repeat(30), 'engineer')
    expect(JSON.stringify(r.detail)).not.toMatch(/missing.{0,30}contact/i)
  })
})

describe('Greenhouse / Lever form-field stripping keeps real prose', () => {
  it('keeps "first name" / "cover letter" inside a sentence', () => {
    const jd = 'You will review each cover letter and normalise first name and last name fields in the CRM. ' + 'More detail about the role. '.repeat(20)
    const out = stripPlatformBoilerplate('boards.greenhouse.io', jd)
    expect(out).toMatch(/review each cover letter and/)
    expect(out).toMatch(/normalise first name and last name fields/)
  })
  it('still strips the form labels', () => {
    const out = stripPlatformBoilerplate('jobs.lever.co', 'Great role. First Name * Last Name * Resume/CV * Cover Letter Apply for this job * Powered by Greenhouse')
    expect(out).not.toMatch(/first name|last name|resume\/cv|cover letter/i)
  })
})
