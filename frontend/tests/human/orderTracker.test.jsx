// @vitest-environment jsdom
// Experts Phase 2A (H): the customer's order tracker: plain-language states, an absolute deadline with its time zone, the expert's name once taken.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import OrderTracker from '../../src/components/human/OrderTracker'
import { trackerModel, formatDeadline } from '../../src/lib/orderTracker'

afterEach(cleanup)
const base = { promisedAt: '2026-10-03T15:00:00Z', expert: null }

describe('trackerModel', () => {
  it('maps every state to exactly one current step, or a banner for the ones that are not a journey', () => {
    for (const state of ['offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted']) {
      const m = trackerModel({ ...base, state }); expect(m.steps.filter(s => s.status === 'current'), state).toHaveLength(1); expect(m.banner).toBeNull()
    }
    for (const state of ['awaiting_payment', 'refunded', 'cancelled', 'disputed']) { const m = trackerModel({ ...base, state }); expect(m.steps).toEqual([]); expect(m.banner).toBeTruthy(); expect(m.deadline).toBeNull() }
  })
  it('steps before the current one are done and the ones after are still to do', () => {
    expect(trackerModel({ ...base, state: 'in_review' }).steps.map(s => s.status)).toEqual(['done', 'done', 'current', 'todo', 'todo'])
  })
  it('the deadline is an absolute date and time with the zone, never a relative phrase', () => {
    const t = formatDeadline('2026-10-03T15:00:00Z', { locale: 'en-US', timeZone: 'Africa/Nairobi' }); expect(t).toBe('Saturday, October 3, 2026 at 6:00:00 PM GMT+3')
    expect(t).not.toMatch(/\bin \d+ (hours|days)\b/i); expect(formatDeadline(null)).toBeNull(); expect(formatDeadline('not a date')).toBeNull()
  })
  it('names the expert only once one has the order, and shows the tier when one is known', () => {
    expect(trackerModel({ ...base, state: 'open', expert: 'Ada K.' }).expert).toBeNull()
    expect(trackerModel({ ...base, state: 'in_progress', expert: 'Ada K.' }).expert).toEqual({ name: 'Ada K.', tier: null })
    expect(trackerModel({ ...base, state: 'in_progress', expert: 'Ada K.', expertTier: 'Senior' }).expert.tier).toBe('Senior')
    expect(trackerModel({ ...base, state: 'delivered', expert: 'Ada K.' }).expert).toBeNull()
  })
  it('says the clock is paused while the expert waits for an answer, and uses the revision deadline in a revision', () => {
    expect(trackerModel({ ...base, state: 'waiting_customer' }).note).toMatch(/paused/); expect(trackerModel({ ...base, state: 'delivered' }).note).toBeNull()      // the order page already states the 72-hour rule
    const rev = trackerModel({ ...base, state: 'revision', revisionDueAt: '2026-10-05T10:00:00Z' }, { locale: 'en-US', timeZone: 'UTC' }); expect(rev.deadline).toMatch(/October 5, 2026/)
  })
  it('shows no deadline before payment or after delivery', () => {
    expect(trackerModel({ ...base, state: 'awaiting_payment' }).deadline).toBeNull(); expect(trackerModel({ ...base, state: 'delivered' }).deadline).toBeNull()
  })
})

describe('A11 trackerModel wording', () => {
  it('an unpaid order is not shown as received: it says it is waiting for payment', () => {
    const m = trackerModel({ ...base, state: 'awaiting_payment' }); expect(m.banner).toMatch(/Waiting for payment/); expect(m.steps).toEqual([])
  })
  it('a revision in progress says so instead of "Ready for your review", and the earlier steps are done', () => {
    const m = trackerModel({ ...base, state: 'revision', revisionDueAt: '2026-10-05T10:00:00Z' })
    expect(m.steps.find(s => s.status === 'current').label).toBe('Your revision is being made'); expect(m.steps.map(s => s.status)).toEqual(['done', 'done', 'done', 'current', 'todo'])
    expect(trackerModel({ ...base, state: 'delivered' }).steps.find(s => s.status === 'current').label).toBe('Ready for your review')
  })
})

describe('OrderTracker', () => {
  it('renders the journey, the expert and the deadline', () => {
    render(<OrderTracker timeZone="UTC" order={{ ...base, state: 'in_progress', expert: 'Ada K.' }} />)
    expect(screen.getByRole('region', { name: 'Order progress' })).toBeTruthy(); expect(screen.getByText('An expert is working on it').getAttribute('aria-current')).toBe('step')
    expect(screen.getByText('Ada K.')).toBeTruthy(); expect(screen.getByText(/October 3, 2026/)).toBeTruthy()
  })
  it('a refunded order shows only the banner', () => {
    render(<OrderTracker order={{ ...base, state: 'refunded' }} />); expect(screen.getByText('This order was refunded.')).toBeTruthy(); expect(screen.queryByRole('list')).toBeNull()
  })
})
