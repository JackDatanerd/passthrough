// @vitest-environment jsdom
// Western-market round: the payout page asks for the routing details of the country the account is in, and offers PayPal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import PartnerPayoutDetails from '../src/pages/PartnerPayoutDetails'
import PartnersLookupPanel from '../src/pages/admin/AdminPartnersLookup'
import { methodLabel, bankRail, bankProblem } from '../src/lib/payoutRails'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
vi.mock('../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../src/components/layout/Footer', () => ({ default: () => null }))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => vi.fn() }))

beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  api.get.mockResolvedValue({ data: { data: { name: 'Alex', payoutMethod: null, payoutDetailsMasked: false, dashboardToken: 'd', taxCountry: '', taxIdMasked: '' } } })
  api.post.mockResolvedValue({ data: { success: true } })
})
afterEach(cleanup)

const page = () => render(<MemoryRouter initialEntries={['/partner/payout-details?token=tok']}><PartnerPayoutDetails /></MemoryRouter>)
const save = () => userEvent.click(screen.getByRole('button', { name: /save payout details/i }))
const country = async code => fireEvent.change(await screen.findByLabelText('Country your bank account is in'), { target: { value: code } })

describe('bank details by country', () => {
  it('a US account asks for the ACH routing number and refuses a mistyped one', async () => {
    page(); await country('US')
    fireEvent.change(screen.getByLabelText('Bank name'), { target: { value: 'Chase' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Alex Morgan' } })
    fireEvent.change(screen.getByLabelText('ACH routing number'), { target: { value: '021000022' } })
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '000123456789' } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: '000123456789' } })
    await save()
    expect(await screen.findByText(/ach routing number doesn.t look right/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('ACH routing number'), { target: { value: '021000021' } })
    await save()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'US', routingCode: '021000021' })
  })
  it('a UK account asks for the sort code', async () => {
    page(); await country('GB')
    expect(screen.getByLabelText('Sort code')).toBeTruthy()
    expect(screen.queryByLabelText('ACH routing number')).toBeNull()
  })
  it('a German account asks for the IBAN instead of an account number and routing code', async () => {
    page(); await country('DE')
    fireEvent.change(screen.getByLabelText('Bank name'), { target: { value: 'Commerzbank' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Jonas Weber' } })
    fireEvent.change(screen.getByLabelText('IBAN'), { target: { value: 'DE89 3704 0044 0532 0130 00' } })
    fireEvent.change(screen.getByLabelText('Re-enter IBAN'), { target: { value: 'DE89 3704 0044 0532 0130 00' } })
    await save()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toMatchObject({ bankCountry: 'DE', accountNumber: 'DE89 3704 0044 0532 0130 00' })
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('routingCode')
  })
  it('a country with no local rail asks for the SWIFT/BIC', async () => {
    page(); await country('OTHER')
    fireEvent.change(screen.getByLabelText('Country code (2 letters)'), { target: { value: 'sg' } })
    expect(await screen.findByLabelText('SWIFT/BIC code')).toBeTruthy()
  })
})

describe('PayPal', () => {
  it('posts the PayPal email and refuses two different emails', async () => {
    page()
    await userEvent.click(await screen.findByRole('button', { name: 'PayPal' }))
    fireEvent.change(screen.getByLabelText('Name on the PayPal account'), { target: { value: 'Alex Morgan' } })
    fireEvent.change(screen.getByLabelText('PayPal email'), { target: { value: 'alex@example.com' } })
    fireEvent.change(screen.getByLabelText('Re-enter PayPal email'), { target: { value: 'alexx@example.com' } })
    await save()
    expect(await screen.findByText(/paypal emails don.t match/i)).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Re-enter PayPal email'), { target: { value: 'Alex@Example.com' } })
    await save()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ payoutMethod: 'PAYPAL', accountName: 'Alex Morgan', paypalEmail: 'alex@example.com' })
  })
})

describe('re-audit round', () => {
  it('one label per payout method, so PayPal is never called mobile money', () => {
    expect([methodLabel('BANK'), methodLabel('MOBILE_MONEY'), methodLabel('PAYPAL'), methodLabel(null)]).toEqual(['Bank transfer', 'Mobile money', 'PayPal', ''])
  })
  it('the admin payout history names a PayPal payout as PayPal', async () => {
    api.get.mockResolvedValue({ data: { data: [{ id: 'po1', partnerId: 'p1', partnerName: 'Alex', partnerEmail: 'a@x.co', amountCents: 5000, currency: 'USD', payoutMethod: 'PAYPAL', paidAt: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z' }], total: 1 } })
    render(<MemoryRouter><PartnersLookupPanel /></MemoryRouter>)
    await userEvent.click(screen.getByText(/Find a code/))
    await userEvent.click(await screen.findByRole('button', { name: 'Payout history' }))
    expect(await screen.findByText('PayPal')).toBeTruthy()
    expect(screen.queryByText('Mobile money')).toBeNull()
  })
  it('New Zealand needs no routing code or SWIFT; a UK roll number is accepted', () => {
    expect(bankRail('NZ')).toBe('local')
    expect(bankProblem({ bankCountry: 'NZ', accountNumber: '12-3456-7890123-00' })).toBe('')
    expect(bankProblem({ bankCountry: 'GB', routingCode: '20-00-00', accountNumber: 'ROLL 1234 567' })).toBe('')
    expect(bankProblem({ bankCountry: 'GB', routingCode: '20-00-00', accountNumber: 'ab' })).toMatch(/UK accounts/)
  })
})

describe('fifth pass', () => {
  it('Canada asks for the transit and institution numbers in two boxes and sends them joined, transit first', async () => {
    page(); await country('CA')
    expect(screen.queryByLabelText('Transit and institution number')).toBeNull()
    fireEvent.change(screen.getByLabelText('Bank name'), { target: { value: 'RBC' } })
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Alex Morgan' } })
    fireEvent.change(screen.getByLabelText('Transit number (5 digits)'), { target: { value: '12345' } })
    fireEvent.change(screen.getByLabelText('Institution number (3 digits)'), { target: { value: '003' } })
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '1234567' } })
    fireEvent.change(screen.getByLabelText('Re-enter account number'), { target: { value: '1234567' } })
    await save()
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).toEqual({ payoutMethod: 'BANK', bankName: 'RBC', accountName: 'Alex Morgan', accountNumber: '1234567', bankCountry: 'CA', routingCode: '12345-003' })
  })
  it('the tax ID box says what to enter and that it is stored encrypted', async () => {
    page()
    expect(await screen.findByText(/SSN or EIN \(US\), UTR \(UK\), or VAT \/ GST number/)).toBeTruthy()
    expect(screen.getByText(/stored encrypted/)).toBeTruthy()
  })
})
