// @vitest-environment jsdom
// Western-market round: the payout page asks for the routing details of the country the account is in, and offers PayPal.
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
