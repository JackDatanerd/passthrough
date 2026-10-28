// @vitest-environment jsdom
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
  payoutDetails: { bankName: 'Equity', accountName: 'K', accountNumber: '…6789' }, dashboardToken: 'd', taxCountry: 'KE', taxIdMasked: '…789B', ...over } } })
const page = () => render(<MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>)

describe('payout page: tax-only save and removal (section 4 fresh pass)', () => {
  it('saves a new tax id without retyping the account number, sending only tax fields', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page()
    await userEvent.type(await screen.findByLabelText('Tax ID'), 'T-998877')
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ taxId: 'T-998877' })
    expect(await screen.findByTestId('tax-saved')).toBeTruthy()
  })
  it('a changed country alone is also a tax-only save', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page()
    fireEvent.change(await screen.findByLabelText(/Country of tax residence/), { target: { value: 'ug' } })
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ taxCountry: 'UG' })
  })
  it('"Remove the tax ID" sends an empty taxId', async () => {
    api.get.mockResolvedValue(saved()); api.post.mockResolvedValue({ data: { success: true } })
    page()
    await userEvent.click(await screen.findByLabelText(/Remove the tax ID/))
    expect(screen.getByLabelText('Tax ID').disabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ taxId: '' })
  })
  it('offers no removal control when no tax id is on file', async () => {
    api.get.mockResolvedValue(saved({ taxIdMasked: '' }))
    page()
    await screen.findByLabelText('Tax ID')
    expect(screen.queryByLabelText(/Remove the tax ID/)).toBeNull()
  })
  it('with nothing changed and no number typed it says nothing has changed (round 45) and posts nothing', async () => {
    api.get.mockResolvedValue(saved())
    page()
    await userEvent.click(await screen.findByRole('button', { name: /save payout details/i }))
    expect(await screen.findByText(/nothing has changed/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
  })
})
