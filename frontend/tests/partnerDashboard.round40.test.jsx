// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerDashboard from '../src/pages/PartnerDashboard'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})

// Partners round 40: the dashboard says where the last code request stands.

const base = codeRequest => ({
  name: 'Ann', commissionRate: 0.2, active: true, status: 'ACTIVE', currency: 'USD', referralCodes: [], notifyConversions: true,
  payoutAccount: null, payoutHoldUntil: null, termsAcceptanceRequired: false, currentTermsVersion: 'v', acceptedTermsVersion: 'v',
  hasPayoutDetails: true, heldCents: 0, minPayoutCents: 0, belowMinimum: false, carriedForwardCents: 0,
  stats: {}, conversions: [], conversionsTotal: 0, payouts: [], cycles: [], codeRequest,
})
const show = async codeRequest => {
  api.get.mockResolvedValue({ data: { success: true, data: base(codeRequest) } })
  render(<MemoryRouter initialEntries={['/partner?token=t']}><PartnerDashboard /></MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('code request status', () => {
  it('an open request shows as waiting, with no button to send another', async () => {
    await show({ status: 'OPEN', wantedCode: 'MYNEWS', createdAt: '2026-10-20T10:00:00Z', resolvedAt: null })
    const el = await screen.findByTestId('code-request-status')
    expect(el.textContent).toMatch(/MYNEWS/)
    expect(screen.queryByTestId('code-request-open')).toBeNull()
  })
  it('an answered request offers to ask again', async () => {
    await show({ status: 'DONE', wantedCode: null, createdAt: '2026-10-01T10:00:00Z', resolvedAt: '2026-10-02T10:00:00Z' })
    await screen.findByTestId('code-request-status')
    expect(screen.getByTestId('code-request-open')).toBeTruthy()
  })
  it('no request: the plain button', async () => {
    await show(null)
    await waitFor(() => expect(screen.getByTestId('code-request-open')).toBeTruthy())
    expect(screen.queryByTestId('code-request-status')).toBeNull()
  })
})
