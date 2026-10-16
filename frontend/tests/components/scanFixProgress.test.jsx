// @vitest-environment jsdom
// Scan/fix waiting states redesign: the wait shows the page being worked on, with time-paced
// steps whose LAST step is held open until the server reports the real result. No percentage,
// no per-line claims, and the "you can leave" note only where it is actually true.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import React from 'react'

import ScanProgress, { SCAN_STEPS, SCAN_STEP_STARTS } from '../../src/components/scan/ScanProgress'
import FixProgress, { FIX_STEP_STARTS } from '../../src/components/scan/FixProgress'
import ResumeSheet from '../../src/components/scan/ResumeSheet'
import { currentStep, gateStep } from '../../src/hooks/useElapsedSeconds'
import { ATS_BADGE_THRESHOLD } from '../../src/lib/scoreThresholds'

const T0 = new Date('2026-10-16T10:00:00Z').getTime()
const iso = msAgo => new Date(T0 - msAgo).toISOString()
const current = () => document.querySelector('[aria-current="step"]')?.textContent || ''
const doneCount = () => document.querySelectorAll('ol li .bg-green-600').length

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('currentStep', () => {
  it('picks the last threshold reached and never goes past the final step', () => {
    expect(currentStep(0, SCAN_STEP_STARTS)).toBe(0)
    expect(currentStep(6, SCAN_STEP_STARTS)).toBe(1)
    expect(currentStep(19.9, SCAN_STEP_STARTS)).toBe(2)
    expect(currentStep(20, SCAN_STEP_STARTS)).toBe(3)
    expect(currentStep(100000, SCAN_STEP_STARTS)).toBe(SCAN_STEPS.length - 1)
  })
})

describe('ScanProgress', () => {
  it('starts on the first step and advances with time', () => {
    render(<ScanProgress createdAt={iso(0)} />)
    expect(current()).toContain('Reading your file')
    act(() => { vi.advanceTimersByTime(7000) })
    expect(current()).toContain('Pulling out sections')
    expect(doneCount()).toBe(1)
  })

  it('holds the last step open however long the scan takes, and never claims completion', () => {
    render(<ScanProgress createdAt={iso(10 * 60 * 1000)} />)
    expect(current()).toContain('Scoring')
    expect(doneCount()).toBe(SCAN_STEPS.length - 1)   // every step but the last is done; the last stays open
  })

  it('anchors to the server timestamp, so a refresh keeps its place', () => {
    render(<ScanProgress createdAt={iso(25_000)} />)
    expect(current()).toContain('Scoring')
  })

  it('treats a missing or future createdAt as "just started" instead of crashing or going negative', () => {
    const { unmount } = render(<ScanProgress createdAt={undefined} />)
    expect(current()).toContain('Reading your file')
    unmount()
    render(<ScanProgress createdAt={iso(-60_000)} />)
    expect(current()).toContain('Reading your file')
  })

  it('never shows a percentage', () => {
    render(<ScanProgress createdAt={iso(15_000)} />)
    expect(document.body.textContent).not.toMatch(/\d+\s?%/)
  })

  it('shows the leave note only when the caller provides one, and always renders children (stalled box, poll errors)', () => {
    const { unmount } = render(<ScanProgress createdAt={iso(0)} leaveNote="You can leave this page." ><p>child-content</p></ScanProgress>)
    expect(screen.getByText('You can leave this page.')).toBeTruthy()
    expect(screen.getByText('child-content')).toBeTruthy()
    unmount()
    render(<ScanProgress createdAt={iso(0)} />)
    expect(screen.queryByText(/You can leave/)).toBeNull()
  })

  it('has a polite live region so assistive tech hears step changes', () => {
    render(<ScanProgress createdAt={iso(0)} />)
    expect(document.querySelector('[role="status"][aria-live="polite"]')).toBeTruthy()
  })
})

describe('FixProgress', () => {
  it('uses the generating copy for a fix and the verifying copy for a badge-only tier', () => {
    const { unmount } = render(<FixProgress tier="FIX" startedAt={iso(0)} />)
    expect(screen.getByText('Generating your fixed resume…')).toBeTruthy()
    expect(document.body.textContent).toContain('Rewriting weak lines')
    unmount()
    render(<FixProgress tier="BADGE" startedAt={iso(0)} />)
    expect(screen.getByText('Verifying and formatting your resume…')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Rewriting weak lines')
  })

  it('keeps the existing email promise and the "you can leave" permission', () => {
    render(<FixProgress tier="FIX" startedAt={iso(0)} />)
    expect(document.body.textContent).toContain("We'll email you when it's ready")
    expect(document.body.textContent).toContain('You can leave this page')
  })

  it('holds the last step until the server delivers', () => {
    render(<FixProgress tier="FIX" startedAt={iso(10 * 60 * 1000)} />)
    expect(current()).toContain('Preparing your files')
    expect(FIX_STEP_STARTS.length).toBe(4)
  })

  it('restarts its pacing when the server timestamp changes (a retry flips the scan back to generating)', () => {
    const { rerender } = render(<FixProgress tier="FIX" startedAt={iso(10 * 60 * 1000)} />)
    expect(current()).toContain('Preparing your files')
    rerender(<FixProgress tier="FIX" startedAt={iso(0)} />)
    expect(current()).toContain('Reading your scan')
  })
})

describe('ResumeSheet', () => {
  it('is decorative: hidden from assistive tech and carrying no text of the user\'s resume', () => {
    render(<ResumeSheet elapsedSeconds={5} />)
    const sheet = screen.getByTestId('resume-sheet')
    expect(sheet.getAttribute('aria-hidden')).toBe('true')
    expect(sheet.textContent).toBe('')
  })

  it('hides the moving beam for people who prefer reduced motion (class-level guarantee)', () => {
    render(<ResumeSheet elapsedSeconds={5} />)
    expect(screen.getByTestId('resume-beam').className).toContain('motion-reduce:hidden')
  })

  it('keeps the beam inside the page however long the wait runs', () => {
    for (const s of [0, 3, 14, 15, 999]) {
      const { unmount } = render(<ResumeSheet elapsedSeconds={s} />)
      const top = parseFloat(screen.getByTestId('resume-beam').style.top)
      expect(top).toBeGreaterThanOrEqual(0); expect(top).toBeLessThan(100)
      unmount()
    }
  })
})

// ── Round 2: the server's own report narrows the clock's guess (migration 0088) ──────────────────────────────────────────
describe('gateStep', () => {
  it('is a floor and a ceiling, and does nothing without a known gate', () => {
    expect(gateStep(0, [2, 3])).toBe(2)
    expect(gateStep(9, [0, 1])).toBe(1)
    expect(gateStep(2, [1, 3])).toBe(2)
    expect(gateStep(2, undefined)).toBe(2)
  })
})

describe('ScanProgress with a reported stage', () => {
  it('never shows "Scoring" while the server says it is still reading, however long that takes', () => {
    render(<ScanProgress createdAt={iso(10 * 60 * 1000)} stage="reading" />)
    expect(current()).toContain('Pulling out sections')
  })
  it('jumps ahead to matching/scoring as soon as the server says it is scoring, even at the start of the clock', () => {
    render(<ScanProgress createdAt={iso(0)} stage="scoring" />)
    expect(current()).toContain('Matching the job')
  })
  it('falls back to the clock for a stage value this build does not know (forward compatible)', () => {
    render(<ScanProgress createdAt={iso(25_000)} stage="some-future-stage" />)
    expect(current()).toContain('Scoring')
  })
})

describe('FixProgress with reported progress', () => {
  const fp = (over = {}) => ({ startedAt: iso(0), round: 0, phase: 'starting', attempt: 0, of: 3, scores: [], ...over })
  const at100s = over => <FixProgress tier="FIX" startedAt={iso(100_000)} round={0} progress={fp({ startedAt: iso(100_000), ...over })} />

  it('follows the real phase: rewriting, scoring and rendering each hold their own step', () => {
    const { unmount } = render(at100s({ phase: 'rewriting', attempt: 1 }))
    expect(current()).toContain('Rewriting weak lines'); unmount()
    const r2 = render(at100s({ phase: 'scoring', attempt: 1, scores: [71] }))
    expect(current()).toContain('Scoring the real file'); r2.unmount()
    render(at100s({ phase: 'rendering', attempt: 1, scores: [71] }))
    expect(current()).toContain('Preparing your files')
  })

  it('anchors to the run\'s own start, so the bookkeeping updates that bump updatedAt cannot reset the steps', () => {
    render(<FixProgress tier="FIX" startedAt={iso(0)} round={0} progress={fp({ startedAt: iso(100_000), phase: 'rendering', scores: [90] })} />)
    expect(current()).toContain('Preparing your files')
  })

  it('shows the real attempt ladder, and says what a further attempt is for', () => {
    render(at100s({ phase: 'rewriting', attempt: 2, scores: [71] }))
    const box = screen.getByTestId('fix-attempts').textContent
    expect(box).toContain('Attempt 1: 71')
    expect(box).toContain('Attempt 2: rewriting…')
    expect(document.body.textContent).toContain(`Aiming for ${ATS_BADGE_THRESHOLD}+`)
  })

  it('marks an attempt that reached the badge line differently from one that fell short', () => {
    render(at100s({ phase: 'rendering', attempt: 2, scores: [71, ATS_BADGE_THRESHOLD + 4] }))
    const chips = [...screen.getByTestId('fix-attempts').querySelectorAll('span')]
    expect(chips[0].className).toContain('text-gray-600')
    expect(chips[1].className).toContain('text-green-700')
  })

  it('shows no ladder on the first attempt: nothing real to show yet', () => {
    render(at100s({ phase: 'rewriting', attempt: 1 }))
    expect(screen.queryByTestId('fix-attempts')).toBeNull()
  })

  it('ignores progress left on the row by a PREVIOUS paid round until the new run writes its own', () => {
    render(<FixProgress tier="FIX" startedAt={iso(0)} round={1} progress={fp({ round: 0, phase: 'rendering', scores: [90], startedAt: iso(100_000) })} />)
    expect(current()).toContain('Reading your scan')
    expect(screen.queryByTestId('fix-attempts')).toBeNull()
  })

  it('the badge-only flow, which reports only starting and rendering, never skips past formatting early', () => {
    render(<FixProgress tier="BADGE" startedAt={iso(0)} round={0} progress={fp({ phase: 'rendering', of: 0 })} />)
    expect(current()).toContain('Formatting your resume')
  })

  it('survives malformed progress without crashing (unknown phase, non-array scores, wrong types)', () => {
    for (const bad of [null, 'x', 7, { round: 0, phase: 'nope', scores: 'x' }, { round: 0, phase: 'rewriting', scores: [null, 'a', 70] }]) {
      const { unmount } = render(<FixProgress tier="FIX" startedAt={iso(0)} round={0} progress={bad} />)
      expect(document.querySelector('[role="status"]')).toBeTruthy()
      unmount()
    }
  })
})
