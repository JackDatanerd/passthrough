// @vitest-environment jsdom
// Section 4 round 22: the payout page no longer drops edits to the payout destination on a tax-only save, shows the
// "On file" line only for the method that is on file, and never puts its write token in a dashboard URL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const saved = (over = {}) => ({ data: { data: { name: 'K', payoutMethod: 'BANK', payoutDetailsMasked: true, payoutDetailsSubmittedAt: '2026-10-01T00:00:00Z',
  payoutDetails: { bankName: 'Chase', accountName: 'K', accountNumber: '…6789' }, dashboardToken: 'd', taxCountry: 'KE', taxIdMasked: '', ...over } } })
const page = () => render(<MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>)
const save = () => userEvent.click(screen.getByRole('button', { name: /save payout details/i }))

describe('payout page: edits are not silently dropped (round 22)', () => {
  it('a changed bank name plus a tax edit, with no number retyped, is refused — nothing is posted and no "saved" notice shows', async () => {
    api.get.mockResolvedValue(saved())
    page()
    const bank = await screen.findByLabelText('Bank name')
    await userEvent.clear(bank); await userEvent.type(bank, 'Wells Fargo')
    await userEvent.type(screen.getByLabelText('Tax ID'), 'T-998877')
    await save()
    expect(await screen.findByText(/re-enter your account number/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    expect(screen.queryByTestId('tax-saved')).toBeNull()
  })
  it('a changed account name alone gets the same answer instead of "fill in every field"', async () => {
    api.get.mockResolvedValue(saved())
    page()
    const name = await screen.findByLabelText('Account name')
    await userEvent.clear(name); await userEvent.type(name, 'K Ltd')
    await save()
    expect(await screen.findByText(/re-enter your account number/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('switching to mobile money without typing the phone number is refused too', async () => {
    api.get.mockResolvedValue(saved())
    page()
    await userEvent.click(await screen.findByRole('button', { name: /mobile money/i }))
    await userEvent.type(screen.getByLabelText('Tax ID'), 'T-998877')
    await save()
    expect(await screen.findByText(/re-enter your phone number/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('an untouched payout section still allows a tax-only save', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page()
    await userEvent.type(await screen.findByLabelText('Tax ID'), 'T-998877')
    await save()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ taxId: 'T-998877' })
  })
})

describe('payout page: the "On file" line (round 22)', () => {
  it('is shown for the method that is on file and hidden after switching to the other one', async () => {
    api.get.mockResolvedValue(saved())
    page()
    expect(await screen.findByTestId('payout-on-file')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /mobile money/i }))
    expect(screen.queryByTestId('payout-on-file')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /bank account/i }))
    expect(screen.getByTestId('payout-on-file')).toBeTruthy()
  })
})

describe('payout page: dashboard link after saving (round 22)', () => {
  async function saveFull(over) {
    api.get.mockResolvedValue(saved({ payoutMethod: null, payoutDetailsMasked: false, payoutDetails: null, ...over }))
    api.post.mockResolvedValue({ data: { success: true } })
    page()
    fireEvent.change(await screen.findByLabelText('Bank name'), { target: { value: 'Wells Fargo' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'K' } })
    fireEvent.change(screen.getByLabelText('Country your bank account is in'), { target: { value: 'US' } })
    fireEvent.change(await screen.findByLabelText('ACH routing number'), { target: { value: '021000021' } })
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '1234567890' } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: '1234567890' } })
    await save()
    await screen.findByText(/details saved/i)
  }
  it('links to the dashboard with the READ-ONLY token', async () => {
    await saveFull({ dashboardToken: 'DASH' })
    expect(screen.getByRole('link', { name: /view your dashboard/i }).getAttribute('href')).toBe('/partner/dashboard?token=DASH')
  })
  it('without a dashboard token it offers the recovery page — the write token never goes into a dashboard URL', async () => {
    await saveFull({ dashboardToken: null })
    expect(screen.queryByRole('link', { name: /view your dashboard/i })).toBeNull()
    const link = screen.getByRole('link', { name: /email me my dashboard link/i })
    expect(link.getAttribute('href')).toBe('/partner/recover')
    expect(document.body.innerHTML).not.toContain('token=tok')
  })
})
