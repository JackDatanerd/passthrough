import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import * as claude from '../src/services/claude.service.js'
import { isUkSpelling } from '../src/services/design.service.js'
const require = createRequire(import.meta.url)
const C = require('../evals/checks.cjs')
const { FIXTURES, REQUIRED_KINDS, checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread } = C
const { GOLD } = require('../evals/gold.cjs')
const clone = o => JSON.parse(JSON.stringify(o))

describe('prompt eval set (offline structure and checks; the live model run is `npm run eval:prompts`)', () => {
  it('has the spread the prompts need to be judged on', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(40)
    const kinds = new Set(FIXTURES.map(f => f.kind))
    for (const k of REQUIRED_KINDS) expect(kinds.has(k), k).toBe(true)
    expect(new Set(FIXTURES.map(f => f.id)).size).toBe(FIXTURES.length)
  })
  it('is split into a dev set (tune against it) and a held-out set (run only before a version bump), both covering most kinds', () => {
    const dev = FIXTURES.filter(f => f.set === 'dev'), hold = FIXTURES.filter(f => f.set === 'holdout')
    expect(dev.length + hold.length).toBe(FIXTURES.length)
    expect(hold.length).toBeGreaterThanOrEqual(12)
    expect(new Set(hold.map(f => f.kind)).size).toBeGreaterThanOrEqual(9)
    expect(new Set(dev.map(f => f.kind)).size).toBeGreaterThanOrEqual(9)
  })
  it('targets US and UK: the locale label agrees with the app\'s own spelling detector, and both locales are well represented', () => {
    for (const f of FIXTURES) {
      expect(['US', 'UK'], f.id).toContain(f.locale)
      expect(isUkSpelling(f.jd), `${f.id} (${f.locale})`).toBe(f.locale === 'UK')
    }
    expect(FIXTURES.filter(f => f.locale === 'UK').length).toBeGreaterThanOrEqual(10)
    expect(FIXTURES.filter(f => f.locale === 'US').length).toBeGreaterThanOrEqual(20)
  })
  it('names are Western except exactly one non-Latin fixture (the unicode case)', () => {
    const nonLatin = FIXTURES.filter(f => f.resume && /[^\u0000-\u024F]/.test(f.resume.name))
    expect(nonLatin.map(f => f.id)).toEqual(['unicode-cyrillic'])
    expect(FIXTURES.some(f => f.resume && /[\u00C0-\u024F]/.test(f.resume.name))).toBe(true)   // accented names are covered too
  })
  it('every fixture is well formed and its "gaps" are genuinely absent from the resume', () => {
    for (const f of FIXTURES) {
      expect(f.jd.length, f.id).toBeGreaterThan(30)
      expect(['dev', 'holdout'], f.id).toContain(f.set)
      if (!f.resume) { expect(f.raw?.length, f.id).toBeGreaterThan(50); for (const g of f.gaps) expect(f.raw.toLowerCase(), `${f.id}:${g}`).not.toContain(g.toLowerCase()); continue }
      expect(f.resume.name && f.resume.email, f.id).toBeTruthy()
      if (f.kind === 'adversarial') continue            // the "gap" is planted in the injected text on purpose
      for (const g of f.gaps) expect(JSON.stringify(f.resume).toLowerCase(), `${f.id}:${g}`).not.toContain(g.toLowerCase())
    }
  })
  it('every fixture exercises the parameters the real call sites pass (level, title), and some carry letter steering', () => {
    for (const f of FIXTURES) expect(typeof f.jobTitle, f.id).toBe('string')
    expect(new Set(FIXTURES.map(f => f.seniority)).size).toBeGreaterThanOrEqual(3)
    expect(FIXTURES.filter(f => f.application && f.application.recipient).length).toBeGreaterThanOrEqual(2)
  })
  it('the guards catch a rewrite that claims a gap, on every fixture that has one', () => {
    for (const f of FIXTURES.filter(x => x.resume && x.gaps.length && x.kind !== 'adversarial')) {
      const bad = clone(f.resume); bad.skills = [...(bad.skills || []), f.gaps[0]]
      expect(checkNoClaimedGaps(f, bad), f.id).not.toEqual([])
      expect(claude.detectFabrication(f.resume, bad), `${f.id} detectFabrication`).toBeTruthy()
    }
  })
  it('a clean rewrite of the original passes every property check', () => {
    for (const f of FIXTURES.filter(x => x.resume)) {
      const same = clone(f.resume)
      expect(checkNoClaimedGaps(f, same).length, f.id).toBe(f.kind === 'adversarial' ? checkNoClaimedGaps(f, same).length : 0)
      expect(checkBulletLengths(same), f.id).toEqual([])
      expect(C.checkNoExtraBullets(f.resume, same), f.id).toEqual([])
      expect(C.checkSkills(f.resume, same), f.id).toEqual([])
      expect(C.checkLevelPreserved(f.resume, same), f.id).toEqual([])
      expect(C.checkSpelling(f, JSON.stringify(same), JSON.stringify(f.resume)), f.id).toEqual([])
    }
  })
  it('property checks fail what they should', () => {
    expect(checkSummary({ summary: 'Too short.' })).not.toEqual([])
    expect(checkBulletLengths({ experience: [{ bullets: ['w '.repeat(40)] }] })).not.toEqual([])
    expect(checkLetterShape('Dear X,\n\nShort!\n\nSincerely,\nY')).not.toEqual([])
    expect(checkScoreSpread([70, 82, 71])).not.toEqual([])
    expect(checkScoreSpread([78, 80, 79])).toEqual([])
    expect(checkScoreSpread([78, 81])).not.toEqual([])                       // the bar is now 2 points, not 5
  })
  it('the gap check matches whole words only ("Go" is not "Google")', () => {
    expect(checkNoClaimedGaps({ gaps: ['Go'] }, { skills: ['Google Analytics'] })).toEqual([])
    expect(checkNoClaimedGaps({ gaps: ['Go'] }, { skills: ['Go', 'SQL'] })).not.toEqual([])
    expect(checkNoClaimedGaps({ gaps: ['R'] }, { summary: 'Reporting and research' })).toEqual([])
  })
  it('the spelling check follows the posting\'s locale and exempts words the person or the posting used', () => {
    const us = { locale: 'US', jd: 'Organization of events' }, uk = { locale: 'UK', jd: 'Organisation of events' }
    expect(C.checkSpelling(us, 'We organised the colour scheme', '')).toHaveLength(2)
    expect(C.checkSpelling(us, 'We organized the color scheme', '')).toEqual([])
    expect(C.checkSpelling(uk, 'We organized the color scheme', '')).toHaveLength(2)
    expect(C.checkSpelling(uk, 'Skilled in analyzing', 'analyzing')).toEqual([])    // the person\'s own word is theirs
  })
  it('the level check catches "assisted" coming back as "led", and the bullet-count check catches padding', () => {
    const o = { experience: [{ bullets: ['Assisted the manager with schedules', 'Helped prepare reports'] }] }
    expect(C.checkLevelPreserved(o, { experience: [{ bullets: ['Led scheduling for the team'] }] })).not.toEqual([])
    expect(C.checkLevelPreserved(o, { experience: [{ bullets: ['Supported scheduling for the team'] }] })).toEqual([])
    expect(C.checkNoExtraBullets(o, { experience: [{ bullets: ['a', 'b', 'c'] }] })).not.toEqual([])
  })
  it('the skill check allows renames in the alias table and rejects invented or version-changed ones', () => {
    const o = { skills: ['Postgres', 'Node js', 'Python 2'], experience: [] }
    expect(C.checkSkills(o, { skills: ['PostgreSQL', 'Node.js', 'Python 2'] })).toEqual([])
    expect(C.checkSkills(o, { skills: ['Python 3'] })).not.toEqual([])
    expect(C.checkSkills(o, { skills: ['Kubernetes'] })).not.toEqual([])
  })
  it('letter checks: closing by locale, no guessed honorific, opening diversity', () => {
    const body = ' word'.repeat(240)
    expect(checkLetterShape(`Dear X,${body}\n\nSincerely,\nY`, { uk: false })).toEqual([])
    expect(checkLetterShape(`Dear X,${body}\n\nSincerely,\nY`, { uk: true })).not.toEqual([])
    expect(checkLetterShape(`Dear X,${body}\n\nYours faithfully,\nY`, { uk: true })).toEqual([])
    expect(C.checkHonorific('Dear Ms. Smith,\n\nHi', {})).not.toEqual([])
    expect(C.checkHonorific('Dear Ms. Smith,\n\nHi', { recipient: 'Ms. Smith' })).toEqual([])
    expect(C.checkHonorific('Dear Sam Smith,\n\nHi', { recipient: 'Sam Smith' })).toEqual([])
    const same = 'Dear A,\n\nLast spring I rebuilt the weekly report and it worked'
    expect(C.openingDuplication([same, same.replace('A', 'B'), 'Dear C,\n\nFor six years I explained things'])).toBeCloseTo(2 / 3)
    expect(C.openingDuplication(['Dear A,\n\nOne thing happened first', 'Dear B,\n\nSomething else began here'])).toBe(0)
  })
  it('scorer reliability checks: verdict flips and requirement-list agreement', () => {
    expect(C.checkFlips([79, 81])).not.toEqual([])
    expect(C.checkFlips([81, 82])).toEqual([])
    expect(C.checkFlips([74, 75])).not.toEqual([])
    expect(C.listAgreement(['SQL', 'Excel'], ['sql', 'excel'])).toBe(1)
    expect(C.listAgreement(['SQL', 'Excel'], ['sql', 'tableau'])).toBeCloseTo(1 / 3)
  })
  it('gold scoring: F1 over fields, hallucinations against the raw text, verbatim bullets', () => {
    const g = GOLD[0]
    const perfect = { experience: g.expected.experience.map(e => ({ ...e, bullets: [] })), skills: g.expected.skills, education: g.expected.education, certifications: [] }
    const s = C.goldScore(g.expected, perfect, g.raw)
    expect(s.f1).toBe(1); expect(s.hallucinated).toEqual([])
    const bad = { ...perfect, skills: [...perfect.skills, 'Kubernetes'], experience: [...perfect.experience, { company: 'Google', title: 'Director', bullets: ['Led the world'] }] }
    const b = C.goldScore(g.expected, bad, g.raw)
    expect(b.f1).toBeLessThan(1); expect(b.hallucinated.join(' ')).toMatch(/google/i); expect(b.verbatimRate).toBeLessThan(1)
    expect(GOLD.length).toBeGreaterThanOrEqual(8)
    for (const x of GOLD) { expect(x.raw.length, x.id).toBeGreaterThan(80); expect(['structure', 'freeform'], x.id).toContain(x.path) }
  })
})
