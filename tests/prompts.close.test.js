import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const claude = require('../src/services/claude.service.js')
const { yearsFromText } = require('../src/lib/careerFacts.js')
const A = require('../src/lib/atsChecklist.js')
const { isBorderline, pickMedian, blended } = require('../src/lib/aiScoreSampling.js')
const { isAllowedRename } = require('../src/lib/skillAliases.js')
const { findRewriteStyleProblems, findProvenanceProblems, findRenameProblems } = require('../src/lib/rewriteStyle.js')
const K = require('../src/prompts/constants.js')
const { REQUIREMENTS_SYSTEM, SCORE_SYSTEM, buildScoreUser } = require('../src/prompts/score.js')
const { REWRITE_SYSTEM, levelGuidance, feedbackFor } = require('../src/prompts/rewrite.js')
const { LETTER_EXAMPLES, letterSystemFor, pickLetterKind } = require('../src/prompts/letter.js')
const { STRUCTURE_SYSTEM, FREEFORM_SYSTEM } = require('../src/prompts/extract.js')
const c = require('../src/config/constants.js')

const clone = o => JSON.parse(JSON.stringify(o))
const NOW = new Date(Date.UTC(2026, 9, 17))
const ok = text => ({ ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) })
function fetchSeq(...texts) {                       // replies in order, last one repeats; records every request body
  const bodies = []; let i = 0
  const f = vi.fn(async (_u, init) => { bodies.push(JSON.parse(init.body)); return ok(texts[Math.min(i++, texts.length - 1)]) })
  f.bodies = bodies; return f
}
afterEach(() => vi.unstubAllGlobals())

// ── years are counted in code ─────────────────────────────────────────────────────────────────────────────────────
describe('yearsFromText — years of experience counted from the resume\'s dates and today\'s date', () => {
  it('counts an open range to the current year and ignores education lines', () => {
    expect(yearsFromText('Analyst, Acme (Mar 2018 - Present)\nBSc, University of X (2011 - 2014)', NOW)).toBe(8)
  })
  it('merges overlapping jobs and does not count gaps', () => {
    expect(yearsFromText('A 2015-2018\nB 2017 - 2020\nC 2022 - 2024', NOW)).toBe(7)
  })
  it('is null when the text carries no usable range, reads two-digit end years, ignores future starts', () => {
    expect(yearsFromText('no dates here', NOW)).toBeNull()
    expect(yearsFromText('Dev 2019-21', NOW)).toBe(2)
    expect(yearsFromText('Planned 2030 - 2032', NOW)).toBeNull()
  })
})

// ── the checklist: cues, years, fixed list ────────────────────────────────────────────────────────────────────────
const JD = 'Accounts Clerk. You will own collections follow-up. Ledger experience is required. 3+ years of experience. Audit exposure a plus.'
const row = (requirement, o = {}) => ({ requirement, priority: 'must', cue: undefined, ...o })
describe('lib/atsChecklist — the number is computed, and every model claim is verified', () => {
  const score = (rows, resumeText, extra = {}) => A.computeChecklistScore({ requirements: rows, seniority: 'match', title: 'strong', ...extra }, { resumeText, jdText: JD, now: NOW })
  it('a "must" whose cue is not a phrase of the posting becomes a "nice" (and an unmarked cue is accepted, as before)', () => {
    const r = score([
      row('collections follow-up', { status: 'met', evidence: 'Chased overdue balances', cue: 'You will own collections follow-up' }),
      row('ledger', { status: 'missing', evidence: '', cue: 'a phrase the posting never says' }),
      row('audit', { status: 'missing', evidence: '', priority: 'nice' }),
    ], 'Chased overdue balances for forty accounts.')
    expect(r.ok).toBe(true)
    expect(r.cueDowngraded).toBe(1)
    expect(r.rows.find(x => x.requirement === 'ledger').priority).toBe('nice')
  })
  it('a generic years requirement is COUNTED from the dates: met, partial or missing, never taken on the model\'s word', () => {
    const rows = yearsRow => [row('collections follow-up', { status: 'met', evidence: 'Chased overdue balances' }), row('ledger', { status: 'met', evidence: 'Kept the ledger' }), yearsRow]
    const text = 'Chased overdue balances. Kept the ledger. Clerk, Acme 2019 - Present'            // 7 years by NOW
    const met = score(rows(row('3+ years experience', { status: 'missing', evidence: '', years: 3 })), text)
    expect(met.rows.find(x => /years/.test(x.requirement))).toMatchObject({ status: 'met', computed: true })
    const jd10 = JD.replace('3+ years', '10+ years')
    const short = A.computeChecklistScore({ requirements: rows(row('10+ years experience', { status: 'met', evidence: 'x', years: 10 })), seniority: 'match', title: 'strong' },
      { resumeText: text.replace('2019', '2025'), jdText: jd10, now: NOW })
    expect(short.rows.find(x => /years/.test(x.requirement))).toMatchObject({ status: 'missing', computed: true })   // 1 year is not 10, whatever the model said
    // a years requirement the posting never states is discarded: the model cannot invent a requirement to fail someone on
    const invented = score(rows(row('10+ years experience', { status: 'met', evidence: 'x', years: 10 })), text.replace('2019', '2025'))
    expect(invented.ok === false || invented.discarded > 0).toBe(true)
    expect((invented.rows || []).some(x => /10\+ years/.test(x.requirement))).toBe(false)
  })
  it('a skill-tied years requirement the model calls "met" is lowered to "partial" when the whole career is shorter', () => {
    const jd = 'Python developer. 5 years of Python required.'
    const r = A.computeChecklistScore({ requirements: [row('5 years of Python', { status: 'met', evidence: 'Wrote Python services', years: 5 }), row('Python', { status: 'met', evidence: 'Wrote Python services' }), row('developer', { status: 'met', evidence: 'Wrote Python services' })], seniority: 'match', title: 'strong' },
      { resumeText: 'Wrote Python services. Dev, Acme 2024 - 2026', jdText: jd, now: NOW })
    expect(r.rows.find(x => /5 years/.test(x.requirement)).status).toBe('partial')
  })
  it('clearly under the years asked overrules the model\'s "match" seniority, and never the other way round', () => {
    const rows = [row('collections follow-up', { status: 'met', evidence: 'Chased overdue balances' }), row('ledger', { status: 'met', evidence: 'Kept the ledger' }), row('3+ years experience', { status: 'met', evidence: '', years: 3 })]
    const young = score(rows, 'Chased overdue balances. Kept the ledger. Clerk 2025 - Present')
    const senior = score(rows, 'Chased overdue balances. Kept the ledger. Clerk 2012 - Present')
    expect(young.score).toBeLessThan(senior.score)
  })
  it('normalizeRequirements keeps only terms of the posting, de-duplicates, and refuses a list that is too short', () => {
    const list = A.normalizeRequirements({ requirements: [
      { requirement: 'collections follow-up', priority: 'must', cue: 'You will own collections follow-up' },
      { requirement: 'collections follow-up', priority: 'must' },
      { requirement: 'quantum chromodynamics', priority: 'must' },
      { requirement: 'ledger', priority: 'nice' }, { requirement: 'audit', priority: 'nice' },
    ] }, JD)
    expect(list.map(r => r.requirement)).toEqual(['collections follow-up', 'ledger', 'audit'])
    expect(list.map(r => r.id)).toEqual([1, 2, 3])
    expect(A.normalizeRequirements({ requirements: [{ requirement: 'ledger', priority: 'must' }] }, JD)).toBeNull()
  })
  it('mergeJudgement joins results by id (or by name in the older shape) and returns null when there is no judgement', () => {
    const fixed = [{ id: 1, requirement: 'ledger', priority: 'must' }, { id: 2, requirement: 'audit', priority: 'nice' }]
    expect(A.mergeJudgement(fixed, { results: [{ id: 2, status: 'met', evidence: 'x' }, { id: 1, status: 'partial', evidence: 'y' }] }).requirements.map(r => r.status)).toEqual(['partial', 'met'])
    expect(A.mergeJudgement(fixed, { requirements: [{ requirement: 'Audit', status: 'met', evidence: 'x' }] }).requirements[1].status).toBe('met')
    expect(A.mergeJudgement(fixed, { aiScore: 100 })).toBeNull()
  })
  it('the cue must read like a must-have, or the requirement must be stated more than once', () => {
    const jdC = A.canon(JD), set = new Set(JD.toLowerCase().split(/\W+/))
    expect(A.cueOk('Ledger experience is required', 'ledger', jdC, set)).toBe(true)
    expect(A.cueOk('', 'ledger', jdC, set)).toBe(false)
    expect(A.cueOk('Audit exposure a plus', 'audit', jdC, set)).toBe(false)
  })
})

// ── the two-pass scorer end to end ────────────────────────────────────────────────────────────────────────────────
describe('scoreResumeWithAI — requirements once per posting, then the resume against that fixed list', () => {
  const reqReply = JSON.stringify({ requirements: [
    { requirement: 'collections follow-up', priority: 'must', cue: 'You will own collections follow-up' },
    { requirement: 'ledger', priority: 'must', cue: 'Ledger experience is required' },
    { requirement: '3+ years experience', priority: 'must', cue: '3+ years of experience', years: 3 },
    { requirement: 'audit', priority: 'nice', cue: '' },
  ] })
  const judged = JSON.stringify({ results: [{ id: 1, status: 'met', evidence: 'Chased overdue balances' }, { id: 2, status: 'met', evidence: 'Kept the ledger' }, { id: 3, status: 'partial', evidence: '' }, { id: 4, status: 'missing', evidence: '' }], seniority: 'match', title: 'strong' })
  it('counts the years from the dates and today\'s date, which the model is told', async () => {
    claude._clearRequirementsCache()
    const f = fetchSeq(reqReply, judged); vi.stubGlobal('fetch', f)
    const r = await claude.scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'Chased overdue balances. Kept the ledger. Clerk, Acme 2019 - Present', JD, { now: NOW })
    expect(r.success).toBe(true)
    const d = JSON.parse(r.data)
    expect(d.checklist.requirements.find(x => /years/.test(x.requirement))).toMatchObject({ status: 'met', computed: true })
    expect(d.checklist.years).toBe(7)
    expect(f.bodies[1].messages[0].content).toContain("Today's date: 2026-10-17")
    expect(f.bodies[1].messages[0].content).toContain('"id":1')
  })
  it('never guesses: a bad requirements reply or a reply with no judgement is a failure, not a score', async () => {
    claude._clearRequirementsCache()
    vi.stubGlobal('fetch', fetchSeq('not json'))
    expect((await claude.scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', JD)).success).toBe(false)
    claude._clearRequirementsCache()
    vi.stubGlobal('fetch', fetchSeq(reqReply, '{"aiScore": 100}'))
    expect((await claude.scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k' }, 'resume', JD)).error).toBe('SCORE_NO_CHECKLIST')
  })
  it('the prompts: pass 1 never sees a resume, pass 2 is told the list is fixed and that years are not its job', () => {
    expect(REQUIREMENTS_SYSTEM).toMatch(/never see a resume/)
    expect(SCORE_SYSTEM).toMatch(/FIXED list/)
    expect(SCORE_SYSTEM).toMatch(/LENGTH OF EXPERIENCE/)
    expect(buildScoreUser('r', 'j', s => s, [{ id: 1, requirement: 'x', priority: 'must' }], NOW)).toMatch(/^Today's date: 2026-10-17/)
  })
})

// ── borderline sampling ───────────────────────────────────────────────────────────────────────────────────────────
describe('lib/aiScoreSampling — only a result a point from the line is sampled again', () => {
  it('blends like the controller (70/30, AI capped 25 above the rule score)', () => {
    expect(blended(80, 90, c)).toBe(83)
    expect(blended(40, 100, c)).toBe(Math.round(40 * 0.7 + 65 * 0.3))
  })
  it('flags a blended score within one point of the pass or credential line, and nothing else', () => {
    expect(isBorderline(80, 80, c)).toBe(true)          // 80 = the credential line
    expect(isBorderline(74, 80, c)).toBe(true)          // 75.8 -> 76, a point from the 75 line
    expect(isBorderline(90, 90, c)).toBe(false)
    expect(isBorderline(40, 40, c)).toBe(false)
    expect(isBorderline(null, 80, c)).toBe(false)
  })
  it('takes the median sample (its whole result travels with it); fewer than three keeps the first', () => {
    const s = [{ result: 'a', ai: 70 }, { result: 'b', ai: 90 }, { result: 'c', ai: 80 }]
    expect(pickMedian(s).result).toBe('c')
    expect(pickMedian(s.slice(0, 2)).result).toBe('a')
    expect(pickMedian([])).toBeNull()
  })
})

// ── renames ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe('lib/skillAliases — a rename is the same thing, never a version or a related tool', () => {
  it.each([
    ['Postgres', 'PostgreSQL', true], ['Node js', 'Node.js', true], ['MS Excel', 'Microsoft Excel', true], ['K8s', 'Kubernetes', true], ['JS', 'JavaScript', true],
    ['AngularJS', 'Angular', false], ['Python 2', 'Python 3', false], ['Java 8', 'Java 17', false], ['SQL', 'data warehousing', false],
    ['Excel reports', 'financial modelling', false], ['React', 'React Native', false],
  ])('%s -> %s is %s', (from, to, allowed) => expect(isAllowedRename(from, to, '')).toBe(allowed))
  it('a version may change only when the resume states the new one', () => {
    expect(isAllowedRename('Java 8', 'Java 17', 'Certified in Java 17')).toBe(true)
  })
})

// ── guards: provenance, renames, whole-resume verb cap ────────────────────────────────────────────────────────────
describe('lib/rewriteStyle — provenance, renames and the whole-resume verb cap', () => {
  const input = { experience: [{ company: 'Acme', bullets: ['Moved nightly jobs to a new scheduler; run time fell from 4 hours to 50 minutes', 'Trained 3 new staff'] }] }
  it('a figure in a bullet the model wrote must come from the input bullets it says it was built from', () => {
    const out = { experience: [{ bullets: ['Cut nightly run time from 4 hours to 50 minutes and by 30% overall'] }] }
    const bad = findProvenanceProblems(input, out, [{ job: 0, bullet: 0, from: [0] }])
    expect(bad).toHaveLength(1); expect(bad[0]).toMatch(/figure 30/)
    expect(findProvenanceProblems(input, { experience: [{ bullets: ['Cut nightly run time from 4 hours to 50 minutes'] }] }, [{ job: 0, bullet: 0, from: [0] }])).toEqual([])
    expect(findProvenanceProblems(input, out, [{ job: 0, bullet: 0, from: [0, 1] }]).length).toBe(1)       // 30 is in neither
  })
  it('provenance that points at nothing valid is skipped, never an error', () => {
    expect(findProvenanceProblems(input, { experience: [] }, [{ job: 5, bullet: 9, from: [0] }, null, { job: 0 }])).toEqual([])
    expect(findProvenanceProblems(input, {}, 'nope')).toEqual([])
  })
  it('flags a rename that changes a version or names a related tool', () => {
    expect(findRenameProblems({ skills: ['Python 2'] }, [{ from: 'Python 2', to: 'Python 3' }])[0]).toMatch(/not the same thing/)
    expect(findRenameProblems({ skills: ['Postgres'] }, [{ from: 'Postgres', to: 'PostgreSQL' }])).toEqual([])
  })
  it(`one opening verb may open at most ${K.VERB_CAP_WHOLE_RESUME} bullets across the whole resume`, () => {
    const jobs = [0, 1, 2, 3].map(i => ({ company: `C${i}`, bullets: ['Managed the rota', `Built tool ${i}`] }))
    const p = findRewriteStyleProblems({ experience: [] }, { experience: jobs })
    expect(p.join(' ')).toMatch(/4 bullets across all roles open with "managed"/)
  })
})

// ── rewrite integration ───────────────────────────────────────────────────────────────────────────────────────────
const base = {
  name: 'Rachel Bennett', email: 'rachel@example.com', phone: null, location: null, linkedin: null, portfolio: null, summary: null,
  experience: [
    { company: 'Ellison Freight', title: 'Operations Analyst', dates: '2016 - 2024', location: null, bullets: ['Wrote weekly reports for 4 regional managers', 'Negotiated renewals with 12 vendors'] },
    { company: 'Harlow Distribution', title: 'Junior Analyst', dates: '2015 - 2016', location: null, bullets: ['Maintained the cost tracker'] },
  ],
  education: [{ institution: 'Ohio State University', degree: 'BS', dates: '2011 - 2015', details: null }],
  skills: ['Excel', 'SQL', 'Postgres'], certifications: [], projects: [], languages: [], awards: [], publications: [], volunteer: [],
}
const JDR = 'Senior Operations Analyst. Own weekly reporting and vendor management. SQL and Excel required. 5+ years.'
describe('rewrite — summary decided in code, level at true scope, provenance and renames checked, no score to chase', () => {
  it('the target line says whether to write a summary (decided from what there is to summarise), and the prompt obeys it', async () => {
    const f = fetchSeq(JSON.stringify({ resume: base, quantificationOpportunities: [] })); vi.stubGlobal('fetch', f)
    await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, base, JDR, null, base, { jobTitle: 'Senior Operations Analyst', seniority: 'senior' })
    expect(f.bodies[0].messages[0].content).toContain('summary: write')
    const thin = { ...clone(base), experience: [{ company: 'Q', title: 'Packer', dates: '2023 - 2024', bullets: ['Packed orders'] }], education: [] }
    expect(claude.summaryWorthWriting(thin)).toBe(false)
    expect(claude.summaryWorthWriting(base)).toBe(true)
    expect(REWRITE_SYSTEM).toMatch(/summary: write/); expect(REWRITE_SYSTEM).toMatch(/summary: keep/)
  })
  it('a senior posting for a two-year person gets STRETCH guidance (true scope), not the senior reader\'s "ownership" push', () => {
    expect(levelGuidance('senior', true, { years: 2 })).toMatch(/STRETCH READER/)
    expect(levelGuidance('senior', true, { years: 2 })).toMatch(/TRUE level/)
    expect(levelGuidance('senior', true, { years: 9 })).toMatch(/SENIOR READER/)
    expect(levelGuidance('senior', true)).toMatch(/SENIOR READER/)            // unknown career length: unchanged
    expect(levelGuidance('executive', true, { years: 4 })).toMatch(/STRETCH READER/)
    expect(levelGuidance('junior', true, { years: 1 })).toMatch(/EARLY-CAREER/)
  })
  it('the career length reaches the guidance through the real call', async () => {
    const young = { ...clone(base), experience: [{ company: 'Acme', title: 'Analyst', dates: '2024 - Present', bullets: ['Wrote weekly reports'] }] }
    const f = fetchSeq(JSON.stringify({ resume: young, quantificationOpportunities: [] })); vi.stubGlobal('fetch', f)
    await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, young, JDR, null, young, { jobTitle: 'Senior Operations Analyst', seniority: 'senior' })
    expect(f.bodies[0].system).toMatch(/STRETCH READER/)
  })
  it('a figure with no source in the bullets it was built from triggers the one corrective pass, which names it', async () => {
    const withBad = clone(base); withBad.experience[0].bullets = ['Wrote weekly reports for 4 regional managers, cutting rework by 4']       // 4 is in the resume, but not in the cited source below
    const reply = JSON.stringify({ resume: withBad, provenance: [{ job: 0, bullet: 0, from: [1] }], skillRenames: [], quantificationOpportunities: [] })
    const f = fetchSeq(reply, JSON.stringify({ resume: base, provenance: [], skillRenames: [], quantificationOpportunities: [] })); vi.stubGlobal('fetch', f)
    const r = await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, base, JDR, null, base, { jobTitle: 'Senior Operations Analyst', seniority: 'senior' })
    expect(r.success).toBe(true); expect(f).toHaveBeenCalledTimes(2)
    expect(f.bodies[1].messages[0].content).toMatch(/uses the figure 4 that is not in the input bullets it was built from/)
  })
  it('a rename to a different version triggers the corrective pass', async () => {
    const reply = JSON.stringify({ resume: base, provenance: [], skillRenames: [{ from: 'Postgres', to: 'Postgres 14' }], quantificationOpportunities: [] })
    const f = fetchSeq(reply, JSON.stringify({ resume: base, provenance: [], skillRenames: [], quantificationOpportunities: [] })); vi.stubGlobal('fetch', f)
    await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, base, JDR, null, base, {})
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.bodies[1].messages[0].content).toMatch(/renamed "Postgres 14", which is not the same thing/)
  })
  it('the writer is never given a score or a target, and the prompt closes the version loophole', () => {
    for (const fb of [feedbackFor({ score: 61, threshold: 80, baseline: true, weakAreas: ['x'] }), feedbackFor({ score: 70, threshold: 80, weakAreas: ['x'] })]) expect(fb).not.toMatch(/\b61\b|\b70\b|\b80\b|\/100/)
    expect(REWRITE_SYSTEM).toMatch(/A version is part of the name/)
    expect(REWRITE_SYSTEM).toMatch(/same thing and differ just in spelling/)
    expect(REWRITE_SYSTEM).not.toMatch(/differ just in spelling or version/)
  })
})

// ── letters ───────────────────────────────────────────────────────────────────────────────────────────────────────
describe('letter prompt — three shapes chosen in code, length from the shared constants', () => {
  it('picks the model letter from what is known: early career, a need to bridge, or strong fit', () => {
    expect(pickLetterKind({ hasJobs: false, years: null, unprovenNeeds: [] })).toBe('early')
    expect(pickLetterKind({ hasJobs: true, years: 1, unprovenNeeds: ['x'] })).toBe('early')
    expect(pickLetterKind({ hasJobs: true, years: 6, unprovenNeeds: ['Kubernetes'] })).toBe('bridge')
    expect(pickLetterKind({ hasJobs: true, years: 6, unprovenNeeds: [] })).toBe('strong')
    expect(pickLetterKind({ hasJobs: true, years: 6 })).toBe('strong')
  })
  it('the three model letters really differ in shape (different openings, different closing moves)', () => {
    const body = k => LETTER_EXAMPLES[k].split('\n\n')
    const firstWords = k => body(k)[1].split(/\s+/).slice(0, 4).join(' ')
    expect(new Set(['strong', 'bridge', 'early'].map(firstWords)).size).toBe(3)
    // no model letter confesses a weakness: the model copies what it is shown
    for (const k of ['strong', 'bridge', 'early']) expect(LETTER_EXAMPLES[k]).not.toMatch(/I (?:have not|do not yet|am yet to|lack)|\bnot yet\b|still learning/i)
  })
  it('states the length from prompts/constants.js and tells the model the code writes the salutation and sign-off', () => {
    const sys = letterSystemFor('strong')
    expect(sys).toContain(`${K.LETTER_WORDS.min}-${K.LETTER_WORDS.max} words`)
    expect(sys).toContain(`${K.LETTER_WORDS.ceiling} is a hard ceiling`)
    expect(sys).toMatch(/software replaces the salutation and the sign-off/)
    expect(sys).toMatch(/<strongest_matches>/)
    expect(sys).toMatch(/<unproven_needs>/)
    expect(sys).toMatch(/NEVER names a weakness/)
  })
})

// ── extraction ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('extraction — scrambled order, warnings, questions, and source spans for model-written bullets', () => {
  const raw = 'ok so i ran the bar at the pub from 2018, about four years i think. poured pints, trained 3 new staff. i know excel'
  const reply = o => JSON.stringify({ name: 'Alex Morgan', email: null, experience: [{ company: 'the pub', title: null, dates: '2018', location: null, bullets: ['Poured pints', 'Trained 3 new staff', 'Managed a team of 40'] }], skills: ['Excel'], education: [],
    warnings: ['left out: the tail of the text'], questions: ['What year did you leave the pub?', 'What was your job title there?'],
    sourceSpans: [{ job: 0, bullet: 0, span: 'poured pints' }, { job: 0, bullet: 1, span: 'trained 3 new staff' }], ...o })
  it('returns warnings and questions as clean strings, and flags bullets with no real source span (reported, not deleted)', async () => {
    const f = fetchSeq(reply()); vi.stubGlobal('fetch', f)
    const r = await claude.structureFreeformText({ ANTHROPIC_API_KEY: 'k' }, raw)
    expect(r.success).toBe(true)
    expect(r.questions).toEqual(['What year did you leave the pub?', 'What was your job title there?'])
    expect(r.warnings).toEqual(['left out: the tail of the text'])
    expect(r.unverifiedBullets).toEqual(['Managed a team of 40'])
    expect(r.needsConfirmation).toBe(true)
    expect(JSON.stringify(r.data)).not.toMatch(/sourceSpans|warnings|questions/)           // none of it reaches the stored resume
    expect(r.data.experience[0].dates).toBe('2018')                                       // start only: no end date was worked out
  })
  it('ignores junk in the notes and an invented span', async () => {
    vi.stubGlobal('fetch', fetchSeq(reply({ warnings: [1, null, '<b>x</b>'], questions: 'nope', sourceSpans: [{ job: 0, bullet: 0, span: 'not in the text at all' }] })))
    const r = await claude.structureFreeformText({ ANTHROPIC_API_KEY: 'k' }, raw)
    expect(r.questions).toEqual([]); expect(r.warnings).toHaveLength(1); expect(r.unverifiedBullets.length).toBe(3)
  })
  it('the structure upload returns warnings; the prompts carry the scrambled-column rule and the derived-date rule', async () => {
    vi.stubGlobal('fetch', fetchSeq(JSON.stringify({ name: 'Jane Doe', experience: [], skills: [], education: [], warnings: ['a sidebar line could not be placed'] })))
    const r = await claude.parseResumeStructure({ ANTHROPIC_API_KEY: 'k' }, 'Jane Doe\nSKILLS\nExcel')
    expect(r.warnings).toEqual(['a sidebar line could not be placed'])
    expect(STRUCTURE_SYSTEM).toMatch(/SCRAMBLED ORDER/); expect(STRUCTURE_SYSTEM).toMatch(/never guess a placement/)
    expect(FREEFORM_SYSTEM).toMatch(/never work out an end date yourself/)
    expect(FREEFORM_SYSTEM).toMatch(/SOURCE SPANS/)
  })
})

// ── versions and shared constants ─────────────────────────────────────────────────────────────────────────────────
describe('per-prompt versions and shared constants', () => {
  it('each prompt has its own generation, and the stamps are built from them', () => {
    expect(Object.keys(K.PROMPT_VERSIONS).sort()).toEqual(['extract', 'letter', 'rewrite', 'score'])
    expect(claude.PROMPT_VERSION).toBe(K.FIX_PROMPT_VERSION)
    expect(claude.LETTER_PROMPT_VERSION).toBe(K.LETTER_PROMPT_VERSION)
    expect(K.FIX_PROMPT_VERSION).toMatch(/^docgen-rewrite\d+\.score\d+\.extract\d+$/)
  })
  it('the letter guard\'s ceiling is the constant the prompt states', () => {
    expect(K.LETTER_WORDS).toEqual({ min: 220, max: 300, ceiling: 320 })
  })
})

// ── opt-in prompt caching ─────────────────────────────────────────────────────────────────────────────────────────
describe('prompt caching (env PROMPT_CACHE; off by default) and the cost ledger', () => {
  const JDX = 'Senior Operations Analyst. Own weekly reporting and vendor management. SQL and Excel required. 5+ years.'
  const reply = JSON.stringify({ resume: base, quantificationOpportunities: [] })
  it('is OFF by default: the request is exactly what it always was (a plain string)', async () => {
    const f = fetchSeq(reply); vi.stubGlobal('fetch', f)
    await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k' }, base, JDX, null, base, {})
    expect(typeof f.bodies[0].system).toBe('string')
    expect(JSON.stringify(f.bodies[0])).not.toMatch(/cache_control/)
  })
  it('on: the stable prompt is a cache-marked block and the per-candidate paragraph follows it, uncached', async () => {
    const f = fetchSeq(reply); vi.stubGlobal('fetch', f)
    await claude.rewriteResumeContent({ ANTHROPIC_API_KEY: 'k', PROMPT_CACHE: 'on' }, base, JDX, null, base, { seniority: 'senior' })
    const sys = f.bodies[0].system
    expect(Array.isArray(sys)).toBe(true); expect(sys).toHaveLength(2)
    expect(sys[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } })
    expect(sys[0].text).toBe(REWRITE_SYSTEM)
    expect(sys[1].cache_control).toBeUndefined(); expect(sys[1].text).toMatch(/READER/)
  })
  it('on: a prompt with nothing after it is one cached block (the scorer prompts)', async () => {
    claude._clearRequirementsCache()
    const f = fetchSeq('x'); vi.stubGlobal('fetch', f)
    await claude.scoreResumeWithAI({ ANTHROPIC_API_KEY: 'k', PROMPT_CACHE: 'true' }, 'r', JDX)
    expect(f.bodies[0].system).toEqual([{ type: 'text', text: REQUIREMENTS_SYSTEM, cache_control: { type: 'ephemeral' } }])
  })
  it('the ledger folds cached tokens in as billing-equivalents, so turning caching on can never under-report spend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000 } }) })))
    const env = { ANTHROPIC_API_KEY: 'k', PROMPT_CACHE: 'on', __usage: [] }
    await claude.rewriteResumeContent(env, base, JDX, null, base, {})
    expect(env.__usage[0]).toMatchObject({ label: 'rewrite', input_tokens: 100 + 1250 + 200, output_tokens: 50, cache_created: 1000, cache_read: 2000 })
  })
})

// ── tracked finding, not fixed here ───────────────────────────────────────────────────────────────────────────────
describe('known limitation (reported, deliberately not changed in this round)', () => {
  it.todo('unsupportedSkills lets through a tool sharing a 5-letter stem with an existing word: "Marketo" on a resume that says "Marketing", "Salesforce" on one that says "sales" (foldWord truncates words of 7+ letters to 5). Tightening it risks flagging honest rewrites such as "analysis" -> "analytics"; needs its own decision.')
})
