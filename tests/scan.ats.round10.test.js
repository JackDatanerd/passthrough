// Scan/ATS round 10 — regression tests for the fixes made in this round.
import { describe, it, expect } from 'vitest'
import { extractJobPostingText } from '../src/services/jd.parser.js'

const ld = obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`
const LONG = 'Build reliable distributed systems in Go and Kubernetes, own services end to end, mentor engineers. '.repeat(4)
const posting = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Staff Engineer', description: `<p>${LONG}</p>` }

describe('JD JSON-LD: length-changing characters before the block', () => {
  it('still reads the posting when the page has characters whose lowercase is longer (İ)', () => {
    const html = `<html><body>${'İ'.repeat(50)}${ld(posting)}</body></html>`
    expect(html.toLowerCase().length).not.toBe(html.length) // the premise of the bug
    const text = extractJobPostingText(html)
    expect(text).not.toBeNull()
    expect(text).toContain('Staff Engineer')
  })
  it('still handles upper-case SCRIPT / TYPE attributes', () => {
    const html = `<HTML><SCRIPT TYPE="application/ld+json">${JSON.stringify(posting)}</SCRIPT></HTML>`
    expect(extractJobPostingText(html)).toContain('Staff Engineer')
  })
})

import { restoreFactualFields, sanitizeResumeShape, detectFabrication } from '../src/services/claude.service.js'

const base = () => ({
  name: 'Jane Doe', email: 'jane@x.com', phone: '+254700111222', location: 'Nairobi', linkedin: 'linkedin.com/in/jane', portfolio: 'jane.dev',
  summary: 'Engineer.',
  experience: [{ company: 'Acme', title: 'Developer', dates: '2019 - 2022', location: 'Remote', bullets: ['Built APIs for the billing team'] }],
  education: [{ institution: 'UoN', degree: 'BSc CS', dates: '2015 - 2019', details: null }],
  skills: ['Python'], certifications: [],
  projects: [{ name: 'Tool', description: 'cli', technologies: ['go'], link: 'https://github.com/jane/tool' }],
  languages: [], awards: [], publications: [], volunteer: [],
})

describe('rewrite output: contact header and project links are carried over exactly', () => {
  it('restores a name, email, phone, linkedin and project link the model changed or dropped', () => {
    const input = base()
    const out = JSON.parse(JSON.stringify(input))
    out.name = 'Jane D.'; out.email = 'jane@y.com'; out.phone = null; out.linkedin = null; out.portfolio = 'other.dev'; out.location = 'Mombasa'
    out.projects[0].link = 'https://evil.example/x'
    const r = restoreFactualFields(input, sanitizeResumeShape(out))
    expect(r).toMatchObject({ name: 'Jane Doe', email: 'jane@x.com', phone: '+254700111222', location: 'Nairobi', linkedin: 'linkedin.com/in/jane', portfolio: 'jane.dev' })
    expect(r.projects[0].link).toBe('https://github.com/jane/tool')
  })
  it('does not invent contact details the input never had', () => {
    const input = base(); input.phone = null; input.linkedin = ''
    const out = JSON.parse(JSON.stringify(input)); out.phone = '+1 555 0100'; out.linkedin = 'linkedin.com/in/made-up'
    const r = restoreFactualFields(input, sanitizeResumeShape(out))
    expect(r.phone).toBeNull(); expect(r.linkedin).toBeNull()
  })
  it('keeps a project link when the model renamed the project it belongs to', () => {
    const input = base()
    const out = JSON.parse(JSON.stringify(input)); out.projects[0].name = 'Tool CLI'; out.projects[0].link = null
    expect(restoreFactualFields(input, sanitizeResumeShape(out)).projects[0].link).toBe('https://github.com/jane/tool')
  })
  it('leaves the improved copy (summary, bullets) alone', () => {
    const input = base()
    const out = JSON.parse(JSON.stringify(input)); out.summary = 'Backend engineer.'; out.experience[0].bullets = ['Built billing APIs']
    const r = restoreFactualFields(input, sanitizeResumeShape(out))
    expect(r.summary).toBe('Backend engineer.'); expect(r.experience[0].bullets).toEqual(['Built billing APIs'])
    expect(detectFabrication(input, r)).toBe(false)
  })
})

import { scoreResume } from '../src/services/ats.service.js'

describe('content score: only experience-style sections feed the action-verb rate', () => {
  const jd = 'Backend engineer with Python, Docker, AWS and PostgreSQL experience building APIs.'
  const exp = `JANE DOE\njane@x.com | Nairobi\n\nSUMMARY\nBackend engineer building APIs.\n\nEXPERIENCE\nAcme Corp - Developer 2019 - 2022\n• Built Python APIs serving 2M requests per day\n• Reduced deploy time by 40% using Docker\n• Led migration of 12 services to AWS\n• Designed PostgreSQL schemas for billing\n• Mentored 3 junior engineers\n\nEDUCATION\nUoN - BSc Computer Science 2015 - 2019\n\nSKILLS\nPython, Docker, AWS, PostgreSQL\n`
  const certs = n => `\nCERTIFICATIONS\n${Array.from({ length: n }, (_, i) => `✓ Certified Professional Track ${i + 1}`).join('\n')}\n`

  it('certifications do not lower the content score', () => {
    const base = scoreResume(exp, jd), withCerts = scoreResume(exp + certs(12), jd)
    expect(withCerts.contentScore).toBe(base.contentScore)
    expect(withCerts.detail.content.actionVerbRate).toBe(1)
  })
  it('awards and publications do not become quantify prompts', () => {
    const extra = `\nAWARDS\n•  Employee of the Year\n\nPUBLICATIONS\n•  A study of distributed log compaction methods\n`
    const r = scoreResume(exp + extra, jd)
    expect(r.detail.content.unquantified.examples.join(' ')).not.toMatch(/Employee of the Year|distributed log/)
  })
  it('weak bullets INSIDE experience still lower the score (the check is not switched off)', () => {
    const weak = exp.replace(/• Built[^\n]*\n• Reduced[^\n]*\n• Led[^\n]*\n• Designed[^\n]*\n• Mentored[^\n]*/, '• Responsible for the API work\n• Was in charge of deployment times\n• The migration of the services\n• Database schemas for billing\n• Junior engineer mentoring duties')
    expect(scoreResume(weak, jd).contentScore).toBeLessThan(scoreResume(exp, jd).contentScore)
  })
  it('a bullet under a job titled like a heading ("Awards Committee Chair") is still counted', () => {
    const t = exp.replace('Acme Corp - Developer 2019 - 2022', 'Awards Committee Chair, Acme 2019 - 2022')
    expect(scoreResume(t, jd).detail.content.unquantified.total).toBe(5)
  })
  it('project bullets still count as bullets (they are written like experience)', () => {
    const t = exp + `\nPROJECTS\nTool\n• A command line utility for the logs of every team here\n`
    expect(scoreResume(t, jd).detail.content.unquantified.total).toBe(6)
  })
  it('a project-only resume (no experience section) keeps scoring from its project bullets', () => {
    const t = `JANE DOE\njane@x.com\n\nPROJECTS\nTool\n• Built a parser handling 10k files per minute\n• Designed a CLI used by 40 engineers\n• Reduced build time by 30% with caching\n\nEDUCATION\nUoN - BSc 2015 - 2019\n`
    expect(scoreResume(t, jd).detail.content.actionVerbRate).toBe(1)
  })
})

import { readFileSync } from 'node:fs'
describe('fix-job lease is owner-scoped; credit grant checks the user', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0089_scan_ats_round10.sql', import.meta.url), 'utf8')
  it('release_fix_job only clears the caller\'s own lease', () => {
    expect(sql).toMatch(/fix_job_lock_token = p_token/)
    expect(sql).toMatch(/p_token is null or fix_job_lock_token is null or fix_job_lock_token = p_token/)
  })
  it('both new parameters default to null so an un-redeployed worker keeps working', () => {
    expect(sql).toMatch(/p_token uuid default null/g)
  })
  it('grant_fix_credit_once refuses before consuming the round when the user does not exist', () => {
    const body = sql.slice(sql.indexOf('function grant_fix_credit_once'))
    expect(body.indexOf('from users where id = p_user_id')).toBeGreaterThan(-1)
    expect(body.indexOf('from users where id = p_user_id')).toBeLessThan(body.indexOf('set fix_credit_round'))
  })
})

import { checkHtmlFidelity } from '../src/services/claude.service.js'
describe('designed PDF: the credential block is checked, not trusted', () => {
  const data = { name: 'Jane Doe', email: 'jane@x.com', linkedin: 'https://linkedin.com/in/jane', summary: 'Backend engineer who builds reliable APIs for payment teams.',
    experience: [{ company: 'Acme', title: 'Developer', dates: '2019 - 2022', bullets: ['Built APIs for the billing team'] }], education: [], skills: ['Python'], certifications: [], projects: [], languages: [], awards: [], publications: [], volunteer: [] }
  const URL = 'https://passthrough.example/verify/AB12CD'
  const page = (head, extra = '') => `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Inter"><style>body{}</style></head><body>
    <h1>Jane Doe</h1>${head}<p>jane@x.com <a href="https://www.linkedin.com/in/jane/">LinkedIn</a></p>${extra}
    <h2>Summary</h2><p>Backend engineer who builds reliable APIs for payment teams.</p>
    <h2>Experience</h2><p>Developer, Acme 2019 - 2022</p><ul><li>Built APIs for the billing team</li></ul><h2>Skills</h2><p>Python</p></body></html>`
  const good = page(`<a href="${URL}">✓ Passthrough Verified</a>`)

  it('passes a page with the link, the credential line and only the resume\'s own links', () => {
    expect(checkHtmlFidelity(data, good, { verificationUrl: URL, verified: true })).toEqual({ ok: true, reasons: [] })
  })
  it('rejects a page with no verification link', () => {
    const r = checkHtmlFidelity(data, page('<span>✓ Passthrough Verified</span>'), { verificationUrl: URL, verified: true })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/verification link is missing/)
  })
  it('rejects a page whose credential link points somewhere else', () => {
    const r = checkHtmlFidelity(data, page('<a href="https://evil.example/v/AB12CD">✓ Passthrough Verified</a>'), { verificationUrl: URL, verified: true })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/missing or points somewhere else|not in the resume/)
  })
  it('rejects a link to an address that is not the verification URL or the resume\'s own', () => {
    const r = checkHtmlFidelity(data, page(`<a href="${URL}">✓ Passthrough Verified</a>`, '<a href="https://tracker.example/x">more</a>'), { verificationUrl: URL, verified: true })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/not in the resume: https:\/\/tracker\.example/)
  })
  it('rejects "Passthrough Verified" on a document the server did not verify', () => {
    const r = checkHtmlFidelity(data, good, { verificationUrl: URL, verified: false })
    expect(r.ok).toBe(false); expect(r.reasons.join(' ')).toMatch(/not verified/)
  })
  it('accepts the unverified wording on an unverified document', () => {
    expect(checkHtmlFidelity(data, page(`<a href="${URL}">Passthrough Scan Report</a>`), { verificationUrl: URL, verified: false }).ok).toBe(true)
  })
  it('rejects a missing credential line on a verified document, and any credential line on a plain one', () => {
    expect(checkHtmlFidelity(data, page(`<a href="${URL}">Scan</a>`), { verificationUrl: URL, verified: true }).reasons.join(' ')).toMatch(/credential line is missing/)
    expect(checkHtmlFidelity(data, good, { verificationUrl: null, verified: false }).ok).toBe(false)
  })
  it('is unchanged for callers that do not pass `verified` (no credential wording check)', () => {
    expect(checkHtmlFidelity(data, page('<span>nothing</span>'), {}).ok).toBe(true)
  })
})
