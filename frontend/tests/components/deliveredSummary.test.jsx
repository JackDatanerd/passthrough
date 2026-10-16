// @vitest-environment jsdom
// Round 3: the picture at the top of a delivered fix. It must say only what the server recorded, hide itself where
// there is no real before-and-after, and never let the attempt ladder contradict the score that was delivered.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import DeliveredSummary from '../../src/components/scan/DeliveredSummary'
import ScoreRoad from '../../src/components/scan/ScoreRoad'
import { ATS_BADGE_THRESHOLD, ATS_PASS_THRESHOLD } from '../../src/lib/scoreThresholds'

afterEach(cleanup)
const fp = (over = {}) => ({ startedAt: '2026-10-16T10:00:00Z', round: 0, phase: 'rendering', attempt: 2, of: 3, scores: [71, 84], ...over })
const scan = (over = {}) => ({ status: 'FIX_DELIVERED', fixTier: 'FIX', atsScore: 52, fixAtsScore: 84, fixRetryCount: 0, rewriteFailed: false, fixProgress: fp(), ...over })
const text = () => screen.getByTestId('delivered-summary').textContent

describe('DeliveredSummary: when it appears', () => {
  it.each([
    ['a badge-only delivery (nothing was rewritten)', { fixTier: 'BADGE' }],
    ['a failed rewrite (the original was delivered)', { rewriteFailed: true }],
    ['no delivered score yet', { fixAtsScore: null }],
  ])('renders nothing for %s', (_, over) => {
    render(<DeliveredSummary scan={scan(over)} />)
    expect(screen.queryByTestId('delivered-summary')).toBeNull()
  })
  it('renders nothing without a scan', () => { render(<DeliveredSummary scan={null} />); expect(screen.queryByTestId('delivered-summary')).toBeNull() })
})

describe('DeliveredSummary: what it says', () => {
  it('past the line: the score, the line, and how far it moved', () => {
    render(<DeliveredSummary scan={scan()} />)
    expect(text()).toContain(`84 out of 100, past the ${ATS_BADGE_THRESHOLD} line.`)
    expect(text()).toContain('Up 32 from 52.')
  })
  it('just short: counts the points to the line, singular for one', () => {
    const { unmount } = render(<DeliveredSummary scan={scan({ fixAtsScore: 76, fixProgress: fp({ scores: [71, 76] }) })} />)
    expect(text()).toContain(`4 points from the ${ATS_BADGE_THRESHOLD}.`); unmount()
    render(<DeliveredSummary scan={scan({ fixAtsScore: ATS_BADGE_THRESHOLD - 1 })} />)
    expect(text()).toContain(`1 point from the ${ATS_BADGE_THRESHOLD}.`)
  })
  it('says nothing about movement when the score did not go up or the original is unknown', () => {
    const { unmount } = render(<DeliveredSummary scan={scan({ atsScore: 90, fixAtsScore: 84 })} />)
    expect(text()).not.toContain('Up '); unmount()
    render(<DeliveredSummary scan={scan({ atsScore: null })} />)
    expect(text()).not.toContain('Up ')
  })
})

describe('DeliveredSummary: the attempt ladder', () => {
  it('shows the real attempts the server recorded for this round', () => {
    render(<DeliveredSummary scan={scan()} />)
    expect(screen.getByTestId('delivered-attempts')).toHaveTextContent('Attempt 1: 71')
    expect(screen.getByTestId('delivered-attempts')).toHaveTextContent('Attempt 2: 84')
    expect(screen.queryByTestId('kept-earlier')).toBeNull()
  })
  it('is hidden for a delivery from before the telemetry existed, and for another round\'s leftovers', () => {
    const { unmount } = render(<DeliveredSummary scan={scan({ fixProgress: null })} />)
    expect(screen.queryByTestId('delivered-attempts')).toBeNull()
    expect(screen.getByTestId('score-road')).toBeTruthy()   // the before/after picture does not depend on it
    unmount()
    render(<DeliveredSummary scan={scan({ fixRetryCount: 1, fixProgress: fp({ round: 0 }) })} />)
    expect(screen.queryByTestId('delivered-attempts')).toBeNull()
  })
  it('on a paid retry where nothing beat the earlier result, says so instead of showing a ladder below the score', () => {
    render(<DeliveredSummary scan={scan({ fixRetryCount: 1, fixAtsScore: 84, fixProgress: fp({ round: 1, scores: [70, 74, 79] }) })} />)
    expect(screen.getByTestId('kept-earlier')).toHaveTextContent('kept that one')
  })
  it('does not claim "kept the earlier result" on a first round', () => {
    render(<DeliveredSummary scan={scan({ fixRetryCount: 0, fixAtsScore: 90, fixProgress: fp({ scores: [70, 74] }) })} />)
    expect(screen.queryByTestId('kept-earlier')).toBeNull()
  })
  it('survives malformed progress', () => {
    for (const bad of ['x', 7, { round: 0, scores: 'nope' }, { round: 0, scores: [null, 'a'] }]) {
      const { unmount } = render(<DeliveredSummary scan={scan({ fixProgress: bad })} />)
      expect(screen.getByTestId('delivered-summary')).toBeTruthy(); unmount()
    }
  })
})

describe('ScoreRoad', () => {
  it('describes itself in words for assistive tech, with both lines', () => {
    render(<ScoreRoad before={52} after={84} />)
    const label = screen.getByTestId('score-road').getAttribute('aria-label')
    expect(label).toContain('Score 84 out of 100, was 52')
    expect(label).toContain(`Pass line ${ATS_PASS_THRESHOLD}`); expect(label).toContain(`Verified line ${ATS_BADGE_THRESHOLD}`)
  })
  it('draws the "was" marker only when the score actually moved', () => {
    const { unmount } = render(<ScoreRoad before={52} after={84} />)
    expect(screen.getByTestId('score-road-before')).toBeTruthy(); unmount()
    const r2 = render(<ScoreRoad before={84} after={84} />)
    expect(screen.queryByTestId('score-road-before')).toBeNull(); r2.unmount()
    render(<ScoreRoad after={84} />)
    expect(screen.queryByTestId('score-road-before')).toBeNull()
  })
  it('keeps a wild number inside the road, and renders nothing for a non-number', () => {
    const { container, unmount } = render(<ScoreRoad before={-20} after={140} />)
    const widths = [...container.querySelectorAll('[style]')].map(e => e.getAttribute('style'))
    expect(widths.join(' ')).not.toMatch(/-\d+%|1[1-9]\d%/)
    unmount()
    const r = render(<ScoreRoad after={NaN} />)
    expect(r.container.firstChild).toBeNull()
  })
})
