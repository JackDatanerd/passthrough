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
import { currentStep } from '../../src/hooks/useElapsedSeconds'

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
    expect(current()).toContain('Scoring the real file')
    expect(FIX_STEP_STARTS.length).toBe(4)
  })

  it('restarts its pacing when the server timestamp changes (a retry flips the scan back to generating)', () => {
    const { rerender } = render(<FixProgress tier="FIX" startedAt={iso(10 * 60 * 1000)} />)
    expect(current()).toContain('Scoring the real file')
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
