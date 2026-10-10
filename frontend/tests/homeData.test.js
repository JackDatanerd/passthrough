import { describe, it, expect } from 'vitest'
import { mergeHomeData } from '../src/hooks/useHomeData'
import { formatScanCount, splitScanCount, avatarColour, initialOf, paragraphs, monthYear } from '../src/lib/homeFormat'
import { STATS_FALLBACK, SAMPLE_STORIES, MIN_LIVE_SCANS, buildFaq } from '../src/lib/homeContent'
import { roleLabel } from '../src/lib/roleCategories'
import { SAMPLE_HOT } from '../src/lib/homeContent'

describe('formatScanCount — rounds DOWN so the claim never overstates', () => {
  it('floors to a readable step and adds a plus', () => {
    expect(formatScanCount(25123)).toBe('25,000+')
    expect(formatScanCount(25000)).toBe('25,000')
    expect(formatScanCount(1999)).toBe('1,900+')
    expect(formatScanCount(432)).toBe('432')
    expect(formatScanCount(123456)).toBe('120,000+')
  })
  it('a fallback ("at least") figure always reads as a lower bound, even when exact', () => {
    expect(formatScanCount(25000, { atLeast: true })).toBe('25,000+')
    expect(formatScanCount(500, { atLeast: true })).toBe('500+')
    expect(splitScanCount(25000, { atLeast: true })).toEqual({ value: 25000, plus: true, text: '25,000+' })
  })
  it('rejects nonsense', () => {
    expect(formatScanCount(NaN)).toBeNull()
    expect(formatScanCount(-1)).toBeNull()
    expect(formatScanCount(undefined)).toBeNull()
  })
  it('splitScanCount ends the count-up exactly on the shown text', () => {
    expect(splitScanCount(25123)).toEqual({ value: 25000, plus: true, text: '25,000+' })
    expect(splitScanCount(25000)).toEqual({ value: 25000, plus: false, text: '25,000' })
  })
})

describe('small formatters', () => {
  it('avatar colour is stable per name; initial skips punctuation', () => {
    expect(avatarColour('Amara O.')).toBe(avatarColour('Amara O.'))
    expect(initialOf('  "amara"')).toBe('A')
    expect(initialOf('')).toBe('?')
  })
  it('splits story paragraphs on blank lines only', () => {
    expect(paragraphs('one\nstill one\n\ntwo\n\n\n three ')).toEqual(['one\nstill one', 'two', 'three'])
    expect(paragraphs(null)).toEqual([])
  })
  it('monthYear is UTC-stable and tolerates junk', () => {
    expect(monthYear('2026-08-01T00:00:00Z')).toBe('August 2026')
    expect(monthYear('nope')).toBeNull()
  })
})

describe('mergeHomeData — live wins, placeholders are flagged, nothing throws', () => {
  it('with no live data at all it serves the editable fallbacks, all flagged', () => {
    const d = mergeHomeData(null)
    expect(d.scans).toEqual({ value: STATS_FALLBACK.resumesScanned, isFallback: true })
    expect(d.rate).toMatchObject({ pct: STATS_FALLBACK.interviewRatePct, isFallback: true, responses: null })
    expect(d.stories).toEqual({ list: SAMPLE_STORIES, isSample: true })
    expect(d.hot[7].isSample).toBe(true)
    expect(d.hot[7].rows[0]).toMatchObject({ category: 'software_engineering' })
  })
  it('a live scan count at or above the minimum wins; below it the fallback stands', () => {
    expect(mergeHomeData({ stats: { resumesScanned: 31234 } }).scans).toEqual({ value: 31234, isFallback: false })
    expect(mergeHomeData({ stats: { resumesScanned: MIN_LIVE_SCANS - 1 } }).scans.isFallback).toBe(true)
  })
  it('a live rate wins and carries its response count and start date', () => {
    const d = mergeHomeData({ stats: { interviewRatePct: 71, responses: 212, since: '2026-08-01T00:00:00Z' } })
    expect(d.rate).toEqual({ pct: 71, responses: 212, since: '2026-08-01T00:00:00Z', isFallback: false })
  })
  it('a null rate from the server (not enough answers) falls back to the editable figure, flagged', () => {
    expect(mergeHomeData({ stats: { interviewRatePct: null } }).rate.isFallback).toBe(true)
  })
  it('live stories replace the samples entirely — real and sample are never mixed', () => {
    const live = [{ id: 'a', displayName: 'Real R.', quote: 'q', story: 's' }]
    expect(mergeHomeData({ stories: live }).stories).toEqual({ list: live, isSample: false })
    expect(mergeHomeData({ stories: [] }).stories.isSample).toBe(true)
  })
  it('hot categories: each window is live or sample independently', () => {
    const d = mergeHomeData({ hotCategories: { 7: [{ category: 'legal', interviews: 12, changePct: null }], 30: [], minReports: 10 } })
    expect(d.hot[7]).toEqual({ rows: [{ category: 'legal', interviews: 12, changePct: null }], isSample: false })
    expect(d.hot[30].isSample).toBe(true)
  })
  it('survives a malformed payload', () => {
    expect(() => mergeHomeData({ stats: 'x', stories: 'y', hotCategories: 5 })).not.toThrow()
  })
})

describe('sample content stays well-formed', () => {
  it('every sample hot category is a real taxonomy key (a typo would print a humanised slug)', () => {
    for (const days of [7, 30]) for (const [key] of SAMPLE_HOT[days]) expect(roleLabel(key)).not.toMatch(/_/)
  })
  it('sample hot lists are sorted high to low (the bar widths assume row 0 is the maximum)', () => {
    for (const days of [7, 30]) {
      const n = SAMPLE_HOT[days].map(r => r[1])
      expect(n).toEqual([...n].sort((a, b) => b - a))
    }
  })
})

describe('buildFaq reads the live product numbers', () => {
  const faq = (o = {}) => buildFaq({ maxFixRetries: 2, freeScansPerDay: 3, anonScansPerHour: 1, badgeThreshold: 80, ...o })
  it('quotes the threshold, retries and free-scan limits it is given', () => {
    const f = faq({ badgeThreshold: 85, maxFixRetries: 3, freeScansPerDay: 5, anonScansPerHour: 2 })
    expect(f.find(i => i.id === 'faq-verified').a).toMatch(/scored 85 or higher/)
    expect(f.find(i => i.id === 'faq-retry').a).toMatch(/3 free retries/)
    expect(f.find(i => i.id === 'faq-account').a).toMatch(/2 times an hour.*5 scans a day/)
  })
  it('reads naturally at 1', () => {
    const f = faq({ maxFixRetries: 1, freeScansPerDay: 1 })
    expect(f.find(i => i.id === 'faq-retry').a).toMatch(/1 free retry,/)
    expect(f.find(i => i.id === 'faq-account').a).toMatch(/Scan once an hour.*1 scan a day/)
  })
  it('never promises an interview, and keeps the id the homepage footnote links to', () => {
    const f = faq()
    expect(f.find(i => i.id === 'faq-66')).toBeTruthy()
    expect(f[0].a).toMatch(/^No/)
  })
})
