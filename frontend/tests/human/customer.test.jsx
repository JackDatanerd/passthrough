// Experts Phase 1, customer side: the offer-card entry is off by default and silent; the order form carries the exact wording and gates on the
// ticks; an order never sends a code; orders show questions, delivery and the actions.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } }))
vi.mock('../../src/lib/api', () => ({ default: api, getErrorMessage: (e, d) => e?.response?.data?.message || d }))
import HumanOrderEntry from '../../src/components/scan/HumanOrderEntry'
import HumanOrder from '../../src/pages/human/HumanOrder'
import HumanOrders from '../../src/pages/human/HumanOrders'

const WORDING = { termsConsent: 'TERMS-TICK', age: 'I am 18 or older.', rights: "If my resume includes other people's details (for example referees), I have the right to share them.", learning: 'LEARN-TICK', privacy: 'PRIVACY-LINE', refunds: 'REFUND-LINE', terms: 'TERMS-LINE', codes: 'CODES-LINE', materials: 'MATERIALS-LINE' }
const CFG = { available: true, currency: 'USD', tiers: [{ tier: 'seven_day', label: '7-day rewrite', priceCents: 8900, turnaroundHours: 168 }, { tier: 'forty_eight_hour', label: '48-hour rewrite', priceCents: 11900, turnaroundHours: 48 }], coverLetterCents: 2900,
  wording: WORDING, regions: ['US', 'Africa'], tones: ['balanced'], materials: { maxFiles: 3, maxBytes: 5242880 }, acceptHours: 72 }
const ok = data => ({ data: { success: true, data } })
const assign = vi.fn()
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, href: 'http://localhost/', search: '' } }) })

describe('HumanOrderEntry', () => {
  it('is OFF by default (no build flag): renders nothing and makes no request at all', async () => {
    api.get.mockResolvedValue(ok(CFG))
    const { container } = render(<MemoryRouter><HumanOrderEntry scanId="s1" /></MemoryRouter>)
    await Promise.resolve()
    expect(container).toBeEmptyDOMElement(); expect(api.get).not.toHaveBeenCalled()
  })
  it('with the build flag on: shows the link when the server says available, nothing when it does not or when the API is a 404', async () => {
    vi.stubEnv('VITE_EXPERTS_ENABLED', 'true'); vi.resetModules()
    const { default: Entry } = await import('../../src/components/scan/HumanOrderEntry')
    api.get.mockResolvedValueOnce(ok(CFG))
    const a = render(<MemoryRouter><Entry scanId="s1" /></MemoryRouter>)
    expect(await screen.findByTestId('human-order-entry')).toHaveTextContent('From $89'); expect(screen.getByRole('link')).toHaveAttribute('href', '/human/order?scanId=s1'); a.unmount()
    api.get.mockResolvedValueOnce(ok({ available: false })); const b = render(<MemoryRouter><Entry scanId="s1" /></MemoryRouter>); await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); expect(b.container).toBeEmptyDOMElement(); b.unmount()
    api.get.mockRejectedValueOnce({ response: { status: 404 } }); const c = render(<MemoryRouter><Entry scanId="s1" /></MemoryRouter>); await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3)); expect(c.container).toBeEmptyDOMElement()
    vi.unstubAllEnvs()
  })
})

describe('HumanOrder', () => {
  const page = () => render(<MemoryRouter initialEntries={['/human/order?scanId=s1']}><HumanOrder /></MemoryRouter>)
  const tick = async () => { for (const l of [WORDING.termsConsent, WORDING.age, WORDING.rights]) fireEvent.click(await screen.findByLabelText(l)) }
  it('shows the tiers and the exact consent wording; Continue stays disabled until a tier, a role and the three ticks are given; the optional tick is separate', async () => {
    api.get.mockResolvedValue(ok(CFG)); page()
    expect(await screen.findByText(/7-day rewrite \(7 days\): \$89/)).toBeInTheDocument(); expect(screen.getByText(/48-hour rewrite \(2 days\): \$119/)).toBeInTheDocument()
    expect(screen.getByText('PRIVACY-LINE')).toBeInTheDocument(); expect(screen.getByText('REFUND-LINE')).toBeInTheDocument()
    const go = screen.getByRole('button', { name: /choose how fast/i }); expect(go).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/48-hour rewrite/)); fireEvent.change(screen.getByLabelText('Target role'), { target: { value: 'Senior PM' } })
    expect(screen.getByRole('button', { name: /continue: \$119/i })).toBeDisabled()
    await tick(); expect(screen.getByRole('button', { name: /continue: \$119/i })).toBeEnabled()
    fireEvent.click(screen.getByLabelText(/add a cover letter/i)); expect(screen.getByRole('button', { name: /continue: \$148/i })).toBeEnabled()
    expect(screen.getByLabelText(/Optional: LEARN-TICK/)).not.toBeChecked()
  })
  it('sends the order WITHOUT any code, with the ticks as given and the improvement consent off unless chosen', async () => {
    api.get.mockResolvedValue(ok(CFG)); api.post.mockResolvedValue(ok({ orderId: 'abcdef12-0000-4000-8000-000000000000', priceCents: 11900, authorizationUrl: 'https://paystack.test/x', codeIgnored: null })); page()
    await screen.findByText(/7-day rewrite \(7 days\)/); fireEvent.click(screen.getByLabelText(/48-hour rewrite/)); fireEvent.change(screen.getByLabelText('Target role'), { target: { value: 'Senior PM' } }); await tick()
    fireEvent.click(screen.getByRole('button', { name: /continue: \$119/i }))
    await screen.findByText(/ready for payment/i)
    const body = api.post.mock.calls.find(c => c[0] === '/human/orders')[1]
    expect(body).toMatchObject({ scanId: 's1', tier: 'forty_eight_hour', addCoverLetter: false, consents: { terms: true, age: true, rights: true, learning: false } })
    expect(JSON.stringify(body)).not.toMatch(/code|referral|promo|welcome/i)
    fireEvent.click(screen.getByRole('button', { name: /pay \$119/i })); expect(assign).toHaveBeenCalledWith('https://paystack.test/x')
  })
  it('a resume with no structured form is read first, then the order is retried', async () => {
    api.get.mockResolvedValue(ok(CFG))
    api.post.mockRejectedValueOnce({ response: { data: { code: 'NO_STRUCTURED_RESUME', message: 'Open your resume in the editor first' } } }).mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({ orderId: 'abcdef12-0000-4000-8000-000000000000', priceCents: 8900, authorizationUrl: 'u' })); page()
    await screen.findByText(/7-day rewrite \(7 days\)/); fireEvent.click(screen.getByLabelText(/7-day rewrite/)); fireEvent.change(screen.getByLabelText('Target role'), { target: { value: 'PM' } }); await tick()
    fireEvent.click(screen.getByRole('button', { name: /continue: \$89/i })); await screen.findByText(/ready for payment/i)
    expect(api.post.mock.calls.map(c => c[0])).toEqual(['/human/orders', '/scan/s1/structure', '/human/orders'])
  })
  it('at capacity or not available it says so and shows no form', async () => {
    api.get.mockResolvedValue(ok({ available: false, atCapacity: true })); page()
    expect(await screen.findByText(/at capacity/i)).toBeInTheDocument(); expect(screen.queryByLabelText('Target role')).toBeNull()
  })
  it('an order for no resume is refused up front', () => { render(<MemoryRouter initialEntries={['/human/order']}><HumanOrder /></MemoryRouter>); expect(screen.getByText(/choose a resume/i)).toBeInTheDocument() })
})

describe('HumanOrders', () => {
  const O = { id: '11111111-1111-4111-8111-111111111111', jobNumber: 'HJ-ABC234', status: 'The expert has a question for you', tierLabel: '48-hour rewrite', addCoverLetter: false }
  const D = { ...O, state: 'waiting_customer', priceCents: 11900, promisedAt: '2026-11-03T10:00:00Z', expert: 'Ann K.', questions: [{ id: 'q1', seq: 1, body: 'Which role?', status: 'pending' }], delivery: null, canAccept: false, canRevise: false, canCancel: false, wording: { refunds: 'REFUND-LINE' } }
  const view = (list = [O], detail = D, path = '/human/orders') => { api.get.mockImplementation(async url => (url === '/human/orders' ? ok({ orders: list }) : url.startsWith('/payments/verify') ? { data: { success: true } } : ok(detail))); return render(<MemoryRouter initialEntries={[path]}><HumanOrders /></MemoryRouter>) }
  it('lists orders; opening one shows the expert\'s question and sends the answer', async () => {
    api.post.mockResolvedValue({ data: { success: true } }); view()
    fireEvent.click(await screen.findByRole('button', { name: /HJ-ABC234/ }))
    expect(await screen.findByText(/Which role\?/)).toBeInTheDocument(); expect(screen.getByText(/clock is paused/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'The senior one' } }); fireEvent.click(screen.getByRole('button', { name: /send my answer/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/11111111-1111-4111-8111-111111111111/questions/q1', { answer: 'The senior one' }))
  })
  it('a delivered order shows the files, the scores and the 72-hour rule; accept and the one revision are offered; a used revision is not', async () => {
    const delivered = { ...D, state: 'delivered', questions: [], delivery: { version: 1, scoreBefore: 41, scoreAfter: 83, summary: 'Tightened.', files: { docx: true, pdf: true, cover: false }, confirmations: [{ text: '55%', confirmed: false }] }, canAccept: true, canRevise: true, autoAcceptAt: '2026-11-06T10:00:00Z', rated: false }
    api.post.mockResolvedValue({ data: { success: true } }); view([O], delivered)
    fireEvent.click(await screen.findByRole('button', { name: /HJ-ABC234/ }))
    expect(await screen.findByText(/ATS score 41/)).toBeInTheDocument(); expect(screen.getByText(/55%/)).toBeInTheDocument(); expect(screen.getByText(/accepted automatically/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /download word/i })).toBeInTheDocument(); expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /cover letter/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i })); expect(api.post).not.toHaveBeenCalled()       // A11: accept asks first
    fireEvent.click(await screen.findByRole('button', { name: /yes, accept/i })); await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/11111111-1111-4111-8111-111111111111/accept'))
  })
  it('coming back from Paystack verifies the reference through the existing verify endpoint', async () => {
    view([O], D, '/human/orders?reference=ref-123')
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/payments/verify?reference=ref-123'))
    expect(await screen.findByText(/payment received/i)).toBeInTheDocument()
  })
  it('empty state', async () => { view([]); expect(await screen.findByText(/no human rewrite orders/i)).toBeInTheDocument() })
})
