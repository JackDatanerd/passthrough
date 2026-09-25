import { describe, it, expect } from 'vitest'
import { scoreResume, stem, detectRoleCategory, detectSeniority } from '../src/services/ats.service.js'

// Auth/Scan audit round — every case below was a measured, reproduced defect.

describe('stem() — singular/plural and derived forms meet at one stem', () => {
  const same = [
    ['engineering', 'engineer'], ['engineers', 'engineer'], ['customers', 'customer'],
    ['managers', 'manager'], ['management', 'manager'], ['managed', 'managing'],
    ['developers', 'developer'], ['stakeholders', 'stakeholder'], ['directors', 'director'],
    ['planning', 'plan'], ['programming', 'programmer'], ['planner', 'plan'],
    ['processes', 'process'], ['databases', 'database'], ['services', 'service'],
    ['deployment', 'deploying'], ['reports', 'reporting'],
  ]
  for (const [a, b] of same) it(`${a} ~ ${b}`, () => expect(stem(a)).toBe(stem(b)))
  it('does not over-stem short/exempt words', () => {
    expect(stem('adding')).toBe(stem('add'))
    expect(stem('installing')).toBe(stem('install'))
    expect(stem('analysis')).toBe('analysis')
  })
})

describe('keyword score no longer depends on singular vs plural wording', () => {
  const resumeSingular = 'Jane Doe\njane@example.com\nEXPERIENCE\nCustomer success engineer.\nManaged a customer portfolio and mentored a junior developer.\nWorked with each stakeholder, director and designer.\n'
  const jdPlural = 'We need engineers, managers, developers, customers, stakeholders, directors, designers. Engineers and managers. Developers and customers. Stakeholders directors designers.'
  it('JD plural vs resume singular matches', () => {
    expect(scoreResume(resumeSingular, jdPlural).keywordScore).toBeGreaterThan(40)
  })
  it('JD singular vs resume plural matches', () => {
    const r = 'Customers engineers managers developers stakeholders directors designers.\n'.repeat(3)
    const jd = 'We need an engineer, manager, developer, customer, stakeholder, director, designer. Engineer and manager. Developer and customer.'
    expect(scoreResume(r, jd).keywordScore).toBeGreaterThan(60)
  })
})

describe('bullet recognition — Content score must not collapse on other glyphs', () => {
  const jd = 'Software engineer with Python and SQL experience.'
  const body = b => `${b}Led a team of five engineers to build data pipelines in Python and SQL, reducing latency by 40% across services.\n${b}Designed and deployed REST APIs used by 200,000 customers each month.\n${b}Improved test coverage from 40% to 90% by introducing automated testing.\n`
  const resume = b => `Jane Doe\njane@example.com | 555-1234\n\nSUMMARY\nBackend engineer.\n\nEXPERIENCE\nSenior Engineer — Acme 2019-2024\n${body(b).repeat(3)}\nEDUCATION\nBSc Computer Science\n\nSKILLS\nPython, SQL, Go\n`
  for (const [name, glyph] of [['•', '• '], ['●', '● '], ['○', '○ '], ['■', '■ '], ['en dash', '– '], ['➢', '➢ '], ['Symbol-font U+F0B7', '\uf0b7 '], ['U+F0A7', '\uf0a7 ']]) {
    it(`${name} bullets are scored as bullets`, () => {
      const r = scoreResume(resume(glyph), jd)
      expect(r.detail.content.actionVerbRate).toBe(1)
      expect(r.contentScore).toBeGreaterThan(60)
    })
  }
  it('a resume whose extractor kept NO bullet characters still gets a sensible Content score (fallback)', () => {
    const r = scoreResume(resume(''), jd)
    expect(r.contentScore).toBeGreaterThan(40)
  })
  it('mixed glyphs that are the same style (• and U+F0B7) are not flagged as inconsistent', () => {
    const t = resume('• ').replace(/• Designed/g, '\uf0b7 Designed')
    expect(scoreResume(t, jd).detail.format.issues).not.toContain('Inconsistent bullet style')
  })
})

describe('section detection is heading-based, not substring-based', () => {
  const prose = `Jane Doe\njane@example.com\nI have years of experience in sales and a strong education in business. My skills are broad and I have great expertise. View my profile online.\n- Led a team of five reps and grew revenue 40% in one year across the region.\n- Managed accounts for more than fifty customers and negotiated renewals worth $200,000.\n`.repeat(3)
  it('a resume with no headings does not get credit for Experience/Education/Skills/Summary', () => {
    const s = scoreResume(prose, 'Sales role').detail.sections
    expect(s.missing).toEqual(expect.arrayContaining(['Experience', 'Education', 'Skills']))
    expect(s.found).not.toContain('Summary')
  })
  it('real headings in the usual spellings are found', () => {
    const t = 'Jane Doe\njane@example.com\n\nPROFESSIONAL SUMMARY\nBackend engineer.\n\nWork Experience\nEngineer at Acme\n\nEducation:\nBSc\n\nTechnical Skills\nGo, SQL\n\nCertifications\nAWS\n'
    const s = scoreResume(t, 'x').detail.sections
    expect(s.missing).toEqual([])
    expect(s.found).toContain('Summary')
    expect(s.hasCertifications).toBe(true)
  })
  it('single-line text (no line structure) keeps the substring fallback instead of reporting everything missing', () => {
    const s = scoreResume('Jane jane@example.com experience education skills summary', 'x').detail.sections
    expect(s.missing).toEqual([])
  })
})

describe('detectRoleCategory', () => {
  const cases = [
    ['We are hiring a Product Manager to own our roadmap and sprint planning. You will partner closely with engineers and designers.', 'product_management'],
    ['Marketing Manager to lead brand and content strategy, working with our engineering team on growth campaigns.', 'marketing'],
    ['Sales Engineer to support account executives with technical demos and quota.', 'sales'],
    ['Registered nurse for clinical patient care. Comfortable with desktop charting software.', 'healthcare'],
    ['Civil engineer for bridge design and structural inspections.', 'other'],
    ['Senior accountant handling accounting, audit prep and month-end close.', 'finance'],
    ['Senior Software Engineer: build backend services in Go. Work with product managers.', 'software_engineering'],
    ['Data Scientist: machine learning models for churn.', 'data_science'],
    ['Warehouse shops and desktops technician', 'other'],
  ]
  for (const [jd, cat] of cases) it(`${cat}: ${jd.slice(0, 45)}…`, () => expect(detectRoleCategory(jd)).toBe(cat))
  it('empty/absent JD is "other"', () => { expect(detectRoleCategory('')).toBe('other'); expect(detectRoleCategory(undefined)).toBe('other') })
})

describe('detectSeniority', () => {
  const cases = [
    ['Sr. Software Engineer to join our team', 'senior'], ['Jr. Analyst wanted', 'junior'], ['Senior Software Engineer', 'senior'],
    ['Account Manager. You will report to the VP of Sales.', 'mid'], ['Marketing Coordinator reporting to our CEO', 'mid'],
    ['Software Engineer. Work closely with the Director of Engineering.', 'mid'],
    ['Associate Director of Marketing', 'lead'], ['Head of Product', 'lead'], ['VP Engineering', 'executive'],
    ['Backend Engineer\n\nRequirements: 10+ years of experience.', 'senior'],
    ['Support Agent\n\n0-2 years of experience preferred', 'junior'],
    ['Intern, Data', 'junior'], ['Lead generation specialist', 'mid'],
  ]
  for (const [jd, lvl] of cases) it(`${lvl}: ${jd.slice(0, 50).replace(/\n/g, ' ')}`, () => expect(detectSeniority(jd)).toBe(lvl))
})
