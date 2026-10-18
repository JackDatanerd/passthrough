import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const claude = require('../src/services/claude.service.js')
const guard = require('../src/lib/claimGuard.js')
const { readerQuality, pickWinner } = require('../src/lib/readerQuality.js')
const { companyFromPosting } = require('../src/lib/jobCompany.js')
const { computeChecklistScore } = require('../src/lib/atsChecklist.js')

// Document-writing prompts, round 2: the claims the prompts forbid and no code enforced (ownership, tools inside bullets,
// results the input never gave, rank words in a summary), the reader-quality tie-break, the company taken from the posting,
// and the checklist's must-have lists that drive the strengths-only cover letter.

const clone = o => JSON.parse(JSON.stringify(o))
const orig = {
  name: 'Ada Njoroge', email: 'a@x.com', summary: null, skills: ['Excel', 'SQL'],
  experience: [{ company: 'Acme Ltd', title: 'Support Analyst', dates: '2019 - 2023', bullets: ['Helped the senior analyst build weekly SQL reports', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents'] }],
  education: [], projects: [], volunteer: [], certifications: [], languages: [], awards: [], publications: [],
}
const rw = bullets => ({ ...clone(orig), experience: [{ ...clone(orig.experience[0]), bullets }] })
const problems = (r, extra = {}) => guard.findClaimProblems(orig, r, { source: 'Support Analyst Acme Ltd ' + orig.experience[0].bullets.join('\n') + ' Excel SQL', ...extra })

describe('findClaimProblems — ownership', () => {
  it('rejects Helped->Led, Assisted->Owned, Supported->Directed (the prompt said never; no code checked)', () => {
    const p = problems(rw(['Led development of weekly SQL reports', 'Owned ticket triage in Zendesk', 'Directed onboarding of new agents']))
    expect(p.length).toBeGreaterThanOrEqual(3)
    expect(p.join(' ')).toMatch(/led|owned|directed/i)
  })
  it('keeps the person\'s own level', () => {
    expect(problems(rw(['Supported the senior analyst in building weekly SQL reports', 'Assisted with ticket triage in Zendesk', 'Supported onboarding of new agents']))).toEqual([])
  })
  it('a rank title, or the person\'s own "led", licenses it', () => {
    const lead = clone(orig); lead.experience[0].title = 'Team Lead'
    expect(guard.findClaimProblems(lead, { ...clone(lead), experience: [{ ...lead.experience[0], bullets: ['Led weekly SQL reports'] }] }, { source: 'Team Lead Acme SQL' })).toEqual([])
    const own = clone(orig); own.experience[0].bullets = ['Led the weekly reports', 'Triaged tickets']
    expect(guard.findClaimProblems(own, { ...clone(own), experience: [{ ...own.experience[0], bullets: ['Directed weekly reports', 'Triaged tickets'] }] }, { source: 'Led the weekly reports Triaged tickets' })).toEqual([])
  })
  it('"lead" the noun and "managed reports" are not claims', () => {
    expect(guard.hasOwnership('Built a lead generation report and managed reports for the support desk')).toBe(false)
    expect(guard.hasOwnership('Managed a team of five')).toBe(true)
    expect(guard.hasOwnership('Managed vendor relationships for the logistics team')).toBe(false)
  })
})

describe('findClaimProblems — tools, results and names inside a bullet or summary', () => {
  it('rejects a tool or name added inside a bullet (only the skills list was checked)', () => {
    const p = problems(rw(['Helped the senior analyst build weekly SQL reports and Tableau dashboards', 'Assisted with triaging tickets in Zendesk and Jira', 'Supported onboarding of new agents']))
    expect(p.join(' ')).toMatch(/Tableau/); expect(p.join(' ')).toMatch(/Jira/)
  })
  it('rejects a lowercase technology a capital-letter check cannot see', () => {
    expect(problems(rw(['Helped the senior analyst build weekly SQL reports with dbt and pandas', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents'])).join(' ')).toMatch(/dbt/)
  })
  it('allows a declared skill rename, and tool names the resume already has', () => {
    expect(problems(rw(['Helped the senior analyst build weekly PostgreSQL reports', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents']), { renames: [{ from: 'SQL', to: 'PostgreSQL' }] })).toEqual([])
  })
  it('rejects a result the input never gave, accepts the swap of the result it did give', () => {
    const p = problems(rw(['Helped the senior analyst build weekly SQL reports that reduced escalations and improved customer satisfaction', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents']))
    expect(p.join(' ')).toMatch(/reduction|improvement/)
    const given = clone(orig); given.experience[0].bullets = ['Cut ticket backlog by half', 'Triaged tickets', 'Onboarded agents']
    expect(guard.findClaimProblems(given, { ...clone(given), experience: [{ ...given.experience[0], bullets: ['Reduced ticket backlog by half', 'Triaged tickets', 'Onboarded agents'] }] }, { source: 'Cut ticket backlog by half Triaged tickets Onboarded agents' })).toEqual([])
  })
  it('summary: rank words, leadership and tools the resume does not support are rejected', () => {
    const s = t => problems({ ...clone(orig), summary: t })
    expect(s('Senior Data Engineer with 4+ years building production pipelines and leading data teams at scale.').length).toBeGreaterThan(0)
    expect(s('Data leader with 4+ years managing analytics teams, fluent in Snowflake and dbt.').length).toBeGreaterThan(0)
    expect(s('Support analyst with 4+ years of SQL reporting and ticket triage in Zendesk.')).toEqual([])
  })
  it('a line the person already wrote is never judged', () => {
    const mine = clone(orig); mine.experience[0].bullets = ['Led the Tableau rollout', 'Triaged tickets', 'Onboarded agents']
    expect(guard.findClaimProblems(mine, clone(mine), { source: 'Led the Tableau rollout' })).toEqual([])
  })
})

describe('rewriteResumeContent — a forbidden claim never ships', () => {
  const resume = clone(orig)
  const reply = bullets => JSON.stringify({ resume: { ...clone(orig), experience: [{ ...clone(orig.experience[0]), bullets }] }, quantificationOpportunities: [], provenance: [], skillRenames: [] })
  const stub = (...bodies) => {
    let i = 0
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: bodies[Math.min(i++, bodies.length - 1)] }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), text: async () => '' })
  }
  it('is rejected with the specifics when the corrective pass still makes the claim', async () => {
    const bad = reply(['Led development of weekly SQL reports', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents'])
    stub(bad, bad)
    const r = await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, resume, 'Data analyst. SQL required. Reporting. Tickets.', null, resume, {})
    expect(r.success).toBe(false); expect(r.error).toBe('FABRICATION_DETECTED'); expect(r.detail.join(' ')).toMatch(/led/i)
  })
  it('ships the corrected draft when the corrective pass fixes it', async () => {
    const bad = reply(['Led development of weekly SQL reports', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents'])
    const good = reply(['Supported the senior analyst in building weekly SQL reports', 'Assisted with triaging tickets in Zendesk', 'Supported onboarding of new agents'])
    stub(bad, good)
    const r = await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, resume, 'Data analyst. SQL required. Reporting. Tickets.', null, resume, {})
    expect(r.success).toBe(true)
  })
})

describe('letter guards — leadership, large spelled counts, horizons', () => {
  const resume = clone(orig)
  const jd = 'Data Analyst at Beta Corp. SQL required. Tableau a plus.'
  const run = text => claude.checkLetter(text, { resumeData: resume, jdText: jd, details: {}, allowedNumbers: claude.numbersIn(JSON.stringify(resume) + jd), facts: { years: 4 }, haveNumbers: claude.numbersIn(JSON.stringify(resume)), corpus: JSON.stringify(resume) + jd })
  const wrap = body => `Dear Hiring Manager,\n\n${body}\n\nSincerely,\nAda Njoroge`
  it('"a team of eleven analysts" and "I led ... owned the strategy" are hard failures', () => {
    expect(run(wrap('At Acme Ltd I trained eleven analysts and ran forty workshops using SQL.')).hard.join(' ')).toMatch(/figures/)
    expect(run(wrap('At Acme Ltd I led the support team and owned the reporting strategy using SQL.')).hard.join(' ')).toMatch(/claims "/)
  })
  it('a plan\'s time horizon is not a claim about the past', () => {
    expect(run(wrap('In the first 90 days I would learn the reporting stack, and over the first two weeks I would sit with the team using SQL.')).hard.join(' ')).not.toMatch(/figures/)
  })
  it('any statement of a weakness is a hard failure', () => {
    expect(run(wrap('I do not yet have experience with Tableau, but I learn quickly with SQL.')).hard.join(' ')).toMatch(/lacks/)
    expect(run(wrap('I am still learning how large teams use SQL.')).hard.join(' ')).toMatch(/lacks/)
    expect(run(wrap('The closest thing I can show to your Tableau need is the weekly SQL reporting I built.')).hard).toEqual([])
  })
})

describe('pickWinner — the better-reading document wins inside a small ATS band, never at the credential line\'s expense', () => {
  const plain = { experience: [{ bullets: ['Responsible for weekly reports', 'Helped with tickets', 'Responsible for onboarding'] }], skills: ['Excel'] }
  const strong = { summary: 'Support analyst who built the weekly reporting pack.', experience: [{ bullets: ['Built the weekly reporting pack used by 12 managers', 'Cut ticket backlog by 40% with a triage rota', 'Trained 30 agents on the new queue'] }], skills: ['Excel'] }
  it('readerQuality prefers the document that reads better', () => { expect(readerQuality(strong)).toBeGreaterThan(readerQuality(plain)) })
  it('inside the band the better reader wins even at a point lower; outside it the score decides', () => {
    expect(pickWinner({ candScore: 77, bestScore: 78, candData: strong, bestData: plain })).toBe(true)
    expect(pickWinner({ candScore: 70, bestScore: 78, candData: strong, bestData: plain })).toBe(false)
    expect(pickWinner({ candScore: 83, bestScore: 78, candData: plain, bestData: strong })).toBe(true)
  })
  it('never trades a credential-clearing document for one below the line', () => {
    expect(pickWinner({ candScore: 79, bestScore: 80, candData: strong, bestData: plain, threshold: 80 })).toBe(false)
    expect(pickWinner({ candScore: 80, bestScore: 79, candData: plain, bestData: strong, threshold: 80 })).toBe(true)
  })
  it('on an exact tie the rewrite wins only when the baseline held', () => {
    expect(pickWinner({ candScore: 80, bestScore: 80, candData: plain, bestData: plain, baselineHeld: true })).toBe(true)
    expect(pickWinner({ candScore: 80, bestScore: 80, candData: plain, bestData: plain, baselineHeld: false })).toBe(false)
  })
})

describe('companyFromPosting — only when the posting really names it', () => {
  it('reads an explicit Company line, and a phrase confirmed by a second mention', () => {
    expect(companyFromPosting('Company: Beta Corp\nSQL required')).toBe('Beta Corp')
    expect(companyFromPosting('Data Analyst\nAbout Northwind Logistics\nNorthwind Logistics is hiring a data analyst.')).toBe('Northwind Logistics')
    expect(companyFromPosting('Join Acme Robotics as a designer. At Acme Robotics, you will build things.')).toBe('Acme Robotics')
  })
  it('returns null rather than guess', () => {
    expect(companyFromPosting('About the role\nYou will own reports. Join our team.')).toBeNull()
    expect(companyFromPosting('About Us\nWe are growing.')).toBeNull()
    expect(companyFromPosting('')).toBeNull()
    expect(companyFromPosting('Join Zorbex today.')).toBeNull()      // one mention, no confirmation
  })
})

describe('checklist — metMust / missingMust carry only ESSENTIAL requirements', () => {
  it('lists essential requirements shown and not shown; a missing nice-to-have is in neither', () => {
    const resumeText = 'Support Analyst at Acme 2019 - 2023. Built SQL reports. Excel dashboards.'
    const jdText = 'Data analyst. SQL required. Excel required. Kubernetes required. Tableau a plus.'
    const parsed = { requirements: [
      { requirement: 'SQL', priority: 'must', status: 'met', evidence: 'Built SQL reports', cue: 'SQL required' },
      { requirement: 'Excel', priority: 'must', status: 'met', evidence: 'Excel dashboards', cue: 'Excel required' },
      { requirement: 'Kubernetes', priority: 'must', status: 'missing', evidence: '', cue: 'Kubernetes required' },
      { requirement: 'Tableau', priority: 'nice', status: 'missing', evidence: '' },
    ] }
    const r = computeChecklistScore(parsed, { resumeText, jdText })
    expect(r.ok).toBe(true)
    expect(r.metMust).toEqual(['SQL', 'Excel'])
    expect(r.missingMust).toEqual(['Kubernetes'])
    expect(r.missingKeywords).toContain('Tableau')
  })
})

describe('findClaimProblems — ordinary purpose wording is not a claimed result', () => {
  it('"so that" and "driving" in a summary or bullet are fine', () => {
    const r = { ...clone(orig), summary: 'Reliable analyst who keeps every report traceable to its source so that managers can trust it, driving steady weekly reporting.' }
    expect(problems(r)).toEqual([])
  })
})
