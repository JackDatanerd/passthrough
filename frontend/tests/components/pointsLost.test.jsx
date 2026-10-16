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
    ['every category perfect, nothing to blame', { keywordScore: 100, formatScore: 100, sectionsScore: 100, contentScore: 100 }],
  ])('returns null for %s', (_, over) => { expect(computePointsLost(scan(over))).toBeNull() })
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
  it('shows at most the three worst, with their reasons, and the distance to the Verified line', () => {
    render(<PointsLost scan={scan()} />)
    const box = screen.getByTestId('points-lost')
    expect(box.querySelectorAll('li').length).toBe(3)
    expect(box).toHaveTextContent('48 of 100 points are missing, and 28 of them stand between you and the 80')
    expect(box).toHaveTextContent('Missing from your resume: kubernetes, terraform')
  })
  it('does not mention the Verified line once the score is past it', () => {
    render(<PointsLost scan={scan({ atsScore: 88, keywordScore: 80 })} />)
    expect(screen.getByTestId('points-lost')).toHaveTextContent('12 of 100 points are missing')
    expect(screen.getByTestId('points-lost')).not.toHaveTextContent('stand between you')
  })
  it('renders nothing when it cannot be said honestly', () => {
    render(<PointsLost scan={scan({ atsDetail: null })} />)
    expect(screen.queryByTestId('points-lost')).toBeNull()
  })
})
