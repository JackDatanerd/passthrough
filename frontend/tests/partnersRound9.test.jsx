// @vitest-environment jsdom
// Section 4 round 9 — payout page (masked number + one-time terms acceptance) and the admin list's setup-email flag.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import PartnerPayoutDetails from '../src/pages/PartnerPayoutDetails'
import AdminPartners from '../src/pages/admin/AdminPartners'

const h = vi.hoisted(() => ({ get: null, post: null }))
vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => vi.fn() }))

afterEach(cleanup)

const payoutPage = () => render(
  <MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>
)
const saved = (over = {}) => ({ data: { data: {
  name: 'Coach K', payoutMethod: 'BANK', payoutDetailsMasked: true, payoutDetailsSubmittedAt: '2026-10-01T00:00:00Z',
  payoutDetails: { bankName: 'Equity', accountName: 'Coach K', accountNumber: '…6789' },
  dashboardToken: 'dash', ...over } } })

describe('PartnerPayoutDetails (round 9)', () => {
  beforeEach(() => { h.post = vi.fn(() => Promise.resolve({ data: { success: true } })) })

  it('shows what is on file as a reference and never prefills the number', async () => {
    h.get = () => Promise.resolve(saved())
    payoutPage()
    expect(await screen.findByText(/…6789/)).toBeInTheDocument()
    expect(screen.getByLabelText('Account number')).toHaveValue('')
    expect(screen.getByLabelText('Re-enter account number')).toHaveValue('')
    expect(screen.getByLabelText('Bank name')).toHaveValue('Equity')
  })

  it('saving after re-typing the number posts exactly the details (no extra fields)', async () => {
    h.get = () => Promise.resolve(saved())
    payoutPage()
    await userEvent.type(await screen.findByLabelText('Account number'), '0123456789')
    await userEvent.type(screen.getByLabelText('Re-enter account number'), '0123456789')
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post.mock.calls[0][1]).toEqual({ payoutMethod: 'BANK', bankName: 'Equity', accountName: 'Coach K', accountNumber: '0123456789' })
  })

  it('refuses to save an edit that leaves the number blank (it is no longer prefilled)', async () => {
    h.get = () => Promise.resolve(saved())
    payoutPage()
    await screen.findByLabelText('Bank name')
    await userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
    expect(await screen.findByText(/fill in every field/i)).toBeInTheDocument()
    expect(h.post).not.toHaveBeenCalled()
  })
})

describe('AdminPartners — setup email flag (round 9)', () => {
  const row = (id, name, payoutLinkEmail) => ({ id, name, email: `${id}@x.co`, status: 'ACTIVE', commissionRate: 0.2, payoutMethod: null, readyToPayCents: 0, heldCents: 0, currency: 'USD', payoutLinkEmail })
  it('flags a failed or throttled setup email, and nothing for a sent or unknown one', async () => {
    const partners = [row('a', 'Ann', { status: 'failed' }), row('b', 'Ben', { status: 'throttled' }), row('c', 'Cy', { status: 'sent' }), row('d', 'Di', null)]
    h.get = url => Promise.resolve(url === '/partners' ? { data: { data: partners } } : { data: { data: [] } })
    render(<MemoryRouter><AdminPartners /></MemoryRouter>)
    expect(await screen.findByText(/setup email failed/i)).toBeInTheDocument()
    expect(screen.getByText(/setup email was throttled/i)).toBeInTheDocument()
    expect(screen.getAllByText(/setup email/i)).toHaveLength(2)
  })
})
