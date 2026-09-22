import { describe, it, expect } from 'vitest'
import { buildResumeDiff } from '../src/lib/resumeDiff.js'

describe('buildResumeDiff', () => {
  it('returns null when there is no original data to diff against', () => {
    expect(buildResumeDiff(null, { summary: 'x' })).toBeNull()
  })

  it('diffs summary, experience bullets, skills, and certifications', () => {
    const original = {
      summary: 'Old summary',
      experience: [{ company: 'Acme', title: 'Engineer', dates: '2020-2022', bullets: ['Did a thing', 'Fixed a bug'] }],
      skills: ['Python', 'SQL'],
      certifications: ['AWS Certified'],
    }
    const rewritten = {
      summary: 'New summary',
      experience: [{ company: 'Acme', title: 'Senior Engineer', dates: '2020-2022', bullets: ['Did a bigger thing', 'Fixed a bug'] }],
      skills: ['Python', 'Kubernetes'],
      certifications: ['AWS Certified'],
    }
    const diff = buildResumeDiff(original, rewritten)
    expect(diff.summary.changed).toBe(true)
    expect(diff.experience[0].titleChanged).toBe(true)
    expect(diff.experience[0].bullets[0].status).toBe('changed')
    expect(diff.experience[0].bullets[1].status).toBe('unchanged')
    expect(diff.skills.unchanged).toEqual(['Python'])
    expect(diff.skills.removed).toEqual(['SQL'])
    expect(diff.skills.added).toEqual(['Kubernetes'])
    expect(diff.certifications.unchanged).toEqual(['AWS Certified'])
  })

  // AUDIT FIX (bug — Scan/ATS section audit): diffList used to return the
  // RAW original/rewritten array elements for skills/certifications —
  // DiffView.jsx's TagList renders each item directly as `{item}` in JSX
  // with no re-coercion, so a wrong-typed entry (nothing enforces
  // array-of-strings on the AI rewrite's raw output before it reaches
  // here) would throw "Objects are not valid as a React child" and blank
  // the whole delivered-fix results page. Every returned item must be a
  // plain, renderable string regardless of what shape it arrived in.
  it('coerces non-string skill/certification entries instead of passing them through raw', () => {
    const original = { skills: ['Python', { name: 'SQL', level: 'expert' }], certifications: [42, 'PMP'] }
    const rewritten = { skills: ['Python', 'Kubernetes', null], certifications: ['PMP'] }
    const diff = buildResumeDiff(original, rewritten)

    // Nothing in the output is ever a non-string — every bucket is safe to
    // render directly as `{item}` in JSX.
    for (const bucket of [diff.skills.unchanged, diff.skills.removed, diff.skills.added,
                            diff.certifications.unchanged, diff.certifications.removed, diff.certifications.added]) {
      for (const item of bucket) expect(typeof item).toBe('string')
    }
    expect(diff.skills.unchanged).toEqual(['Python'])
    expect(diff.certifications.unchanged).toEqual(['PMP'])
  })

  it('never throws on malformed AI-sourced fields (bullets/company/title as wrong types)', () => {
    const original = { experience: [{ company: 123, title: null, dates: undefined, bullets: [55, null, 'ok'] }] }
    const rewritten = { experience: [{ company: 123, title: 'Engineer', bullets: ['ok', 'new'] }] }
    expect(() => buildResumeDiff(original, rewritten)).not.toThrow()
  })
})
