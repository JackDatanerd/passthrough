// @vitest-environment jsdom
// Section 4 round 37 (frontend): with masked bank details on file the page picks the right input for a UK account (IBAN vs sort code).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerPayoutDetails from '../src/pages/PartnerPayoutDetails'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
beforeEach(() => { cleanup(); vi.clearAllMocks() })
afterEach(cleanup)

const onFile = details => api.get.mockResolvedValue({ data: { data: { name: 'Alex', payoutMethod: 'BANK', payoutDetailsMasked: true, payoutDetailsSubmittedAt: '2026-01-01T00:00:00Z',
  dashboardToken: 'd', taxCountry: '', taxIdMasked: '', payoutDetails: { bankName: 'Barclays', accountName: 'Alex', accountNumber: '\u20263000', bankCountry: 'GB', ...details } } } })
const page = () => render(<MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>)

describe('UK account on file', () => {
  it('shows the IBAN box when the account on file has no sort code', async () => {
    onFile({})
    page()
    await waitFor(() => expect(screen.getByLabelText('IBAN')).toBeTruthy())
    expect(screen.queryByLabelText('Sort code')).toBeNull()
  })
  it('shows the sort-code box when one is on file', async () => {
    onFile({ routingCode: '20-00-00' })
    page()
    await waitFor(() => expect(screen.getByLabelText('Sort code')).toBeTruthy())
    expect(screen.getByLabelText('Account number')).toBeTruthy()
    expect(screen.queryByLabelText('IBAN')).toBeNull()
  })
})
