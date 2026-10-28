// @vitest-environment jsdom
// Round 4: "where your points went". The split must add up to the real gap, rank worst first, and stay silent whenever it
// could not be said honestly (no weights from the server, no score, nothing to attribute).
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import { computePointsLost, reasonFor } from '../../src/lib/pointsLost'
import PointsLost from '../../src/components/scan/PointsLost'

afterEach(cleanup)
const W = { keywords: 0.35, format: 0.25, sections: 0.2, content: 0.2 }
const scan = (over = {}) => ({
  atsScore: 52, keywordScore: 30, formatScore: 60, sectionsScore: 70, contentScore: 55,
  atsDetail: { weights: W, keywords: { missing: ['kubernetes', 'terraform'], warnings: [] }, format: { issues: ['Skills sit in a table'] },
    sections: { missing: ['Education'] }, content: { unquantified: { count: 3, total: 5, examples: ['a'] }, actionVerbRate: 0.4 } }, ...over })

describe('computePointsLost', () => {
  it('adds up to the real gap exactly, however the rounding falls', () => {
    for (let s = 1; s <= 99; s += 7) for (const k of [0, 30, 77]) {
      const r = computePointsLost(scan({ atsScore: s, keywordScore: k }))
      if (r && r.items.length) expect(r.items.reduce((a, i) => a + i.points, 0)).toBe(100 - s)
    }
  })
  it('ranks the biggest weighted shortfall first', () => {
    const r = computePointsLost(scan())
    expect(r.gap).toBe(48)
    expect(r.items[0].key).toBe('keywords')   // 0.35 x 70 is the largest loss
    expect(r.items.map(i => i.points)).toEqual([...r.items.map(i => i.points)].sort((a, b) => b - a))
  })
  it('gives a category with zero weight (no scoreable keywords) nothing, and splits the rest', () => {
    const r = computePointsLost(scan({ atsDetail: { ...scan().atsDetail, weights: { ...W, keywords: 0 } } }))
    expect(r.items.find(i => i.key === 'keywords')).toBeUndefined()
    expect(r.items.reduce((a, i) => a + i.points, 0)).toBe(48)
  })
  it.each([
    ['no weights from the server', { atsDetail: { keywords: {} } }],
    ['no score yet', { atsScore: null }],
    ['a rules-only score with every category perfect (nothing to blame)', { atsScore: 99, scoredWithoutAi: true, keywordScore: 100, formatScore: 100, sectionsScore: 100, contentScore: 100 }],
  ])('returns null for %s', (_, over) => { expect(computePointsLost(scan(over))).toBeNull() })
  it('blames the AI review, not a perfect category, when the rules are all full marks and the blended score is still low', () => {
    const r = computePointsLost(scan({ atsScore: 88, keywordScore: 100, formatScore: 100, sectionsScore: 100, contentScore: 100,
      atsDetail: { ...scan().atsDetail, aiMissingKeywords: ['kubernetes', 'terraform'] } }))
    expect(r.gap).toBe(12)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ key: 'ai', points: 12 })
    expect(r.items[0].reason).toContain('kubernetes')
  })
  it('gives the rules only their 70% share of the gap and the AI review the rest', () => {
    // rules 80 (every category 80), AI 40 -> blended 0.7 x 80 + 0.3 x 40 = 68, gap 32 = 14 (rules) + 18 (AI)
    const r = computePointsLost(scan({ atsScore: 68, keywordScore: 80, formatScore: 80, sectionsScore: 80, contentScore: 80 }))
    expect(r.gap).toBe(32)
    expect(r.items.find(i => i.key === 'ai').points).toBe(18)
    expect(r.items.filter(i => i.key !== 'ai').reduce((a, i) => a + i.points, 0)).toBe(14)
  })
  it('a rules-only (provisional) score puts the whole gap on the rule categories', () => {
    const r = computePointsLost(scan({ atsScore: 68, scoredWithoutAi: true, keywordScore: 68, formatScore: 68, sectionsScore: 68, contentScore: 68 }))
    expect(r.items.find(i => i.key === 'ai')).toBeUndefined()
    expect(r.items.reduce((a, i) => a + i.points, 0)).toBe(32)
  })
  it('reads the rules-only flag where the server really sends it (atsDetail.scoredWithoutAi), not only at the top level', () => {
    const base = scan({ atsScore: 68, keywordScore: 68, formatScore: 68, sectionsScore: 68, contentScore: 68 })
    const r = computePointsLost({ ...base, atsDetail: { ...base.atsDetail, scoredWithoutAi: true } })
    expect(r.items.find(i => i.key === 'ai')).toBeUndefined()
    expect(r.items.reduce((a, i) => a + i.points, 0)).toBe(32)
    expect(computePointsLost({ ...base, atsDetail: { ...base.atsDetail, scoredWithoutAi: false } }).items.find(i => i.key === 'ai')).toBeDefined()
  })
  it('a perfect score has no gap and no items', () => { expect(computePointsLost(scan({ atsScore: 100 }))).toEqual({ gap: 0, items: [] }) })
  it('clamps wild category scores instead of producing negative points', () => {
    const r = computePointsLost(scan({ keywordScore: 400, formatScore: -50 }))
    expect(r.items.every(i => i.points > 0)).toBe(true)
  })
})

describe('reasonFor', () => {
  const d = scan().atsDetail
  it('says the real thing for each category', () => {
    expect(reasonFor('keywords', d)).toBe('Missing from your resume: kubernetes, terraform')
    expect(reasonFor('format', d)).toBe('Skills sit in a table')
    expect(reasonFor('sections', d)).toBe('Missing: Education')
    expect(reasonFor('content', d)).toBe('3 of 5 bullets give no number')
  })
  it('caps a long keyword list, falls back to warnings and action-verb rate, and is null with nothing to say', () => {
    expect(reasonFor('keywords', { keywords: { missing: ['a', 'b', 'c', 'd', 'e', 'f'] } })).toBe('Missing from your resume: a, b, c, d and 2 more')
    expect(reasonFor('keywords', { keywords: { missing: [], warnings: ['copied posting text'] } })).toBe('Copied posting text')
    expect(reasonFor('content', { content: { actionVerbRate: 0.4 } })).toBe('Only 40% of bullets open with an action verb')
    expect(reasonFor('format', { format: { issues: ['a', 'b'] } })).toBe('a (and 1 more)')
    expect(reasonFor('sections', { sections: { missing: [] } })).toBeNull()
    expect(reasonFor('content', null)).toBeNull()
  })
})

describe('PointsLost', () => {
  it('shows at most the three worst, each with its reason, under "The three biggest reasons"', () => {
    render(<PointsLost scan={scan()} />)
    const box = screen.getByTestId('points-lost')
    expect(box).toHaveTextContent('The three biggest reasons')
    expect(box.querySelectorAll('li').length).toBe(3)
    expect(box).toHaveTextContent('Missing from your resume: kubernetes, terraform')
    expect(box).toHaveTextContent('\u2212')
  })
  it('with `all`, lists every point lost under its own heading', () => {
    render(<PointsLost scan={scan()} all />)
    const box = screen.getByTestId('points-lost')
    expect(box).toHaveTextContent('Every point lost')
    expect(box.querySelectorAll('li').length).toBeGreaterThanOrEqual(3)
  })
  it('renders nothing when it cannot be said honestly', () => {
    render(<PointsLost scan={scan({ atsDetail: null })} />)
    expect(screen.queryByTestId('points-lost')).toBeNull()
  })
})
