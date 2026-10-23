// Scan / ATS round 18 - one test group per fix. Each states the failure it used to produce.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ats = require('../src/services/ats.service')
const { pickWinner } = require('../src/lib/readerQuality.js')

const JD = 'Backend Engineer\nRequirements\nNode.js, PostgreSQL, payments'
const body = (headerLines) => [
  'Jane Doe', ...headerLines, 'PROFESSIONAL SUMMARY', 'Backend engineer building payment systems.',
  'EXPERIENCE', 'Engineer, Acme', '2019 - 2023', '• Built payment APIs handling 2M requests daily', '• Led a team of 5 engineers',
  'EDUCATION', 'BSc CS, UoN', '2015 - 2019', 'SKILLS', 'Node.js, PostgreSQL'
].join('\n')

describe('B1: a phone number is contact information (it used to need an email)', () => {
  const sections = t => ats.scoreResume(t, JD).detail.sections
  it('phone, location and profile link but no email: Contact is found', () => {
    const s = sections(body(['+254 712 345 678 | Nairobi | linkedin.com/in/jane']))
    expect(s.missing).not.toContain('Contact'); expect(s.found).toContain('Contact')
  })
  it('common phone shapes count', () => {
    for (const p of ['(555) 123-4567', '555-123-4567', '0712345678', '+1 555 123 4567', '+44 20 7946 0958'])
      expect(sections(body([p])).missing, p).not.toContain('Contact')
  })
  it('date ranges, years and short numbers are not a phone', () => {
    for (const h of ['2019 - 2023', '2015 2019 2021', 'Nairobi 00100', 'Page 1 of 2'])
      expect(sections(body([h])).missing, h).toContain('Contact')
  })
  it('an email still counts, and no contact at all is still reported', () => {
    expect(sections(body(['jane@example.com'])).missing).not.toContain('Contact')
    expect(sections(body([])).missing).toContain('Contact')
  })
})

describe('B2: four-letter plurals meet their singular', () => {
  it.each([['apis', 'api'], ['apps', 'app'], ['kpis', 'kpi'], ['sdks', 'sdk'], ['bugs', 'bug'], ['tags', 'tag'], ['pods', 'pod'], ['rois', 'roi'], ['ctas', 'cta']])('%s = %s', (a, b) => {
    expect(ats.stem(a)).toBe(ats.stem(b))
  })
  it('words that only look plural stay whole', () => {
    for (const w of ['less', 'plus', 'this', 'bias', 'gas', 'class', 'mass', 'sass', 'redis', 'aws', 'ios', 'dns'])
      expect(ats.stem(w), w).toBe(w)
  })
  it('a posting that says "REST APIs" credits a resume that says "REST API"', () => {
    const jd = 'Backend Engineer\nRequirements\n- Design and build REST APIs\n- Experience with APIs, SQL, Docker'
    const res = 'Jane\njane@x.com\nExperience\n• Built REST API for payments\nEducation\nSkills\nREST API, SQL, Docker\nSummary'
    const k = ats.scoreResume(res, jd).detail.keywords
    expect(k.matched).toContain('apis'); expect(k.missing).not.toContain('apis')
  })
})

describe('B3: very short text - sections are whole words', () => {
  it('"information" / "transformation" are not an Education section', () => {
    const s = ats.scoreResume('Jane Doe jane@x.com\nI manage information systems and transformation programs.\nBuilt apis.', JD).detail.sections
    expect(s.found).not.toContain('Education')
  })
  it('a flattened one-line resume still finds its real headings', () => {
    const s = ats.scoreResume('Jane Doe jane@x.com Experience Acme Engineer Education UoN BSc Skills Node.js', JD).detail.sections
    expect(s.found).toEqual(expect.arrayContaining(['Experience', 'Education', 'Skills']))
  })
})

describe('B4: a Try Again never hands back a lower score than the delivery it replaces', () => {
  const plain = { experience: [{ bullets: ['Responsible for weekly reports', 'Helped with tickets'] }], skills: ['Excel'] }
  const strong = { summary: 'Support analyst.', experience: [{ bullets: ['Built the weekly reporting pack used by 12 managers', 'Cut backlog by 40%'] }], skills: ['Excel'] }
  it('inside the band a better reader still wins on a first run, but not below the floor', () => {
    expect(pickWinner({ candScore: 77, bestScore: 78, candData: strong, bestData: plain })).toBe(true)
    expect(pickWinner({ candScore: 77, bestScore: 78, candData: strong, bestData: plain, floor: 78 })).toBe(false)
    expect(pickWinner({ candScore: 78, bestScore: 78, candData: strong, bestData: plain, floor: 78 })).toBe(true)
    expect(pickWinner({ candScore: 82, bestScore: 78, candData: plain, bestData: strong, floor: 78 })).toBe(true)
  })
  it('the controller passes the delivered score as the floor on retry rounds only', () => {
    const src = require('fs').readFileSync(require.resolve('../src/controllers/scan.controller.js'), 'utf8')
    expect(src).toMatch(/floor: isRetry && typeof scan\.fixAtsScore === 'number' \? scan\.fixAtsScore : null/)
  })
})
