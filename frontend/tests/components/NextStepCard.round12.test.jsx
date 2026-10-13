// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NextStepCard from '../../src/components/dashboard/NextStepCard'

// Profile & Dashboard round 12 (B1): the two kinds nextSteps() now returns.
const scan = (id, over = {}) => ({ id, status: 'FIX_DELIVERED', atsScore: 40, fixAtsScore: 62, fixPurchased: true, fixTier: 'FIX', fixRetryCount: 0, jobTitle: `Job ${id}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', ...over })
const renderCard = (steps) => render(<MemoryRouter><NextStepCard steps={steps} hasScans credits={0} prices={{}} onBreakdown={() => {}} /></MemoryRouter>)

describe('NextStepCard: retry', () => {
  it('names the scan, its score and the free retry, linking to the scan', () => {
    renderCard([{ kind: 'retry', scan: scan('a') }])
    expect(screen.getByRole('heading', { name: /Job a/ })).toHaveTextContent(/62/)
    expect(screen.getByRole('link', { name: /free retry/i })).toHaveAttribute('href', '/scan/a')
    expect(screen.queryByText('All caught up')).toBeNull()
  })
})
describe('NextStepCard: stuck', () => {
  it('says it has not moved and links to the scan', () => {
    renderCard([{ kind: 'stuck', scan: scan('s', { status: 'SCANNING', atsScore: null, fixAtsScore: null, fixPurchased: false }) }])
    expect(screen.getByRole('heading', { name: /Job s/ })).toHaveTextContent(/stuck/i)
    expect(screen.getByRole('link', { name: /open it/i })).toHaveAttribute('href', '/scan/s')
  })
})
describe('NextStepCard: also-rows', () => {
  it('describe a retry and a stuck scan in words', () => {
    renderCard([
      { kind: 'cred', scan: scan('c', { status: 'COMPLETE_PASS', atsScore: 85, fixPurchased: false, fixAtsScore: null }) },
      { kind: 'retry', scan: scan('r') },
      { kind: 'stuck', scan: scan('s', { status: 'SCANNING' }) },
    ])
    expect(screen.getByText(/Job r/).closest('div')).toHaveTextContent(/free retry/i)
    expect(screen.getByText(/Job s/).closest('div')).toHaveTextContent(/stuck/i)
  })
})
