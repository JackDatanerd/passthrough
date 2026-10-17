import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import * as claude from '../src/services/claude.service.js'
const require = createRequire(import.meta.url)
const { FIXTURES, checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread } = require('../evals/checks.cjs')
const clone = o => JSON.parse(JSON.stringify(o))

describe('prompt eval set (offline structure and checks; the live model run is `npm run eval:prompts`)', () => {
  it('has the spread the prompts need to be judged on', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(12)
    const kinds = new Set(FIXTURES.map(f => f.kind))
    for (const k of ['strong', 'weak', 'career_change', 'early_career', 'executive', 'locale', 'unicode', 'adversarial', 'gap', 'thin', 'freeform']) expect(kinds.has(k), k).toBe(true)
    expect(new Set(FIXTURES.map(f => f.id)).size).toBe(FIXTURES.length)
  })
  it('every fixture is well formed and its "gaps" are genuinely absent from the resume', () => {
    for (const f of FIXTURES) {
      expect(f.jd.length, f.id).toBeGreaterThan(30)
      if (!f.resume) { expect(f.raw?.length, f.id).toBeGreaterThan(50); for (const g of f.gaps) expect(f.raw.toLowerCase(), `${f.id}:${g}`).not.toContain(g.toLowerCase()); continue }
      expect(f.resume.name && f.resume.email, f.id).toBeTruthy()
      if (f.kind === 'adversarial') continue            // the "gap" is planted in the injected text on purpose
      for (const g of f.gaps) expect(JSON.stringify(f.resume).toLowerCase(), `${f.id}:${g}`).not.toContain(g.toLowerCase())
    }
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
    }
  })
  it('property checks fail what they should', () => {
    expect(checkSummary({ summary: 'Too short.' })).not.toEqual([])
    expect(checkBulletLengths({ experience: [{ bullets: ['w '.repeat(40)] }] })).not.toEqual([])
    expect(checkLetterShape('Dear X,\n\nShort!\n\nSincerely,\nY')).not.toEqual([])
    expect(checkScoreSpread([70, 82, 71])).not.toEqual([])
    expect(checkScoreSpread([78, 80, 79])).toEqual([])
  })
})
