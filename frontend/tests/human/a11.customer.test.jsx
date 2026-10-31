// @vitest-environment jsdom
// A11 (frontend and expert site), customer side. Each test states the correct behaviour; the first pass confirmed the old behaviour by failing them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } }))
vi.mock('../../src/lib/api', () => ({ default: api, getErrorMessage: (e, d) => e?.response?.data?.message || d }))
import HumanOrders from '../../src/pages/human/HumanOrders'
import HumanOrder from '../../src/pages/human/HumanOrder'
import { classifyVerify } from '../../src/lib/humanPaymentCheck'

const ok = data => ({ data: { success: true, data } })
const order = (o = {}) => ({ id: 'o1', jobNumber: 'HJ-1', state: 'open', status: 'x', tierLabel: '7-day', addCoverLetter: false, priceCents: 8900, promisedAt: '2026-11-07T10:00:00Z', expert: null, questions: [], delivery: null, materials: [], wording: { refunds: 'R' }, ...o })
const serve = (o, extra = {}) => api.get.mockImplementation(async url => {
  if (extra[url]) return extra[url]()
  if (url === '/human/orders') return ok({ orders: [o] })
  if (url.startsWith('/human/orders/')) return ok(o)
  throw new Error('unexpected ' + url)
})
const mount = (url = '/human/orders') => render(<MemoryRouter initialEntries={[url]}><HumanOrders /></MemoryRouter>)
const openIt = async () => { fireEvent.click(await screen.findByText('HJ-1')); await screen.findByLabelText('Order progress') }
const assign = vi.fn()
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign, href: 'http://localhost/', search: '' } }) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('classifyVerify', () => {
  it('reads every answer of the verify endpoint for what it is', () => {
    expect(classifyVerify({ body: { success: true, data: { scanId: null } } }).kind).toBe('paid')
    expect(classifyVerify({ body: { success: false, pending: true } }).kind).toBe('pending')
    expect(classifyVerify({ body: { success: true, data: { refunded: true } } }).kind).toBe('refunded')
    expect(classifyVerify({ body: { success: true, data: { disputed: true } } }).kind).toBe('disputed')
    expect(classifyVerify({ err: { response: { status: 400, data: { message: 'Not completed.' } } } })).toEqual({ kind: 'failed', message: 'Not completed.' })
    expect(classifyVerify({ err: { response: { status: 409, data: { needsSupport: true, message: 'Contact us.' } } } })).toEqual({ kind: 'support', message: 'Contact us.' })
    expect(classifyVerify({ err: { response: { status: 429, data: {} } } }).kind).toBe('rate-limited')
    expect(classifyVerify({ err: { response: { status: 401, data: {} } } }).kind).toBe('session')
    expect(classifyVerify({ err: { response: { status: 502, data: {} } } }).kind).toBe('error'); expect(classifyVerify({ err: new Error('network') }).kind).toBe('error')
  })
})

describe('A11 coming back from Paystack', () => {
  it('B1 a 202 pending is not reported as "Payment received"; it is polled and then reported as paid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); let calls = 0
    serve(order({ state: 'awaiting_payment', promisedAt: null }), { '/payments/verify?reference=ref1': async () => (++calls < 3 ? { status: 202, data: { success: false, pending: true } } : { data: { success: true, data: { scanId: null } } }) })
    mount('/human/orders?reference=ref1')
    expect(await screen.findByText(/still being confirmed/i)).toBeTruthy(); expect(screen.queryByText(/Payment received/)).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(await screen.findByText(/Payment received/)).toBeTruthy(); expect(calls).toBe(3)
  })
  it('B1 a declined payment says what the server says, not "still confirming"', async () => {
    serve(order({ state: 'awaiting_payment', promisedAt: null }), { '/payments/verify?reference=ref1': async () => { throw { response: { status: 400, data: { success: false, declined: true, message: 'This payment was not completed, so you have not been charged.' } } } } })
    mount('/human/orders?reference=ref1')
    expect(await screen.findByText(/not been charged/i)).toBeTruthy(); expect(screen.queryByText(/still being confirmed/i)).toBeNull(); expect(screen.queryByText(/Payment received/)).toBeNull()
  })
  it('B1 a payment that needs support says so and does not retry', async () => {
    let calls = 0
    serve(order({ state: 'awaiting_payment', promisedAt: null }), { '/payments/verify?reference=ref1': async () => { calls++; throw { response: { status: 409, data: { needsSupport: true, message: 'We have your payment; contact support.' } } } } })
    mount('/human/orders?reference=ref1'); expect(await screen.findByText(/contact support/i)).toBeTruthy()
    await new Promise(r => setTimeout(r, 150)); expect(calls).toBe(1)
  })
  it('B1 a still-pending payment stops after a bounded number of checks and offers "Check again"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); let calls = 0
    serve(order({ state: 'awaiting_payment', promisedAt: null }), { '/payments/verify?reference=ref1': async () => { calls++; return { status: 202, data: { success: false, pending: true } } } })
    mount('/human/orders?reference=ref1'); await screen.findByText(/still being confirmed/i)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(calls).toBe(8); expect(await screen.findByText(/email you/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /check again/i })); await act(async () => { await vi.advanceTimersByTimeAsync(10) }); expect(calls).toBe(9)
  })
  it('B1 a failed check is retried a couple of times, so a blip does not leave a false message', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); let calls = 0
    serve(order(), { '/payments/verify?reference=ref1': async () => { if (++calls < 3) throw { response: { status: 502, data: {} } }; return { data: { success: true, data: {} } } } })
    mount('/human/orders?reference=ref1'); await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(await screen.findByText(/Payment received/)).toBeTruthy()
  })
})

describe('A11 orders page', () => {
  it('B2 cancelling a paid order asks first, then cancels', async () => {
    serve(order({ canCancel: true })); api.post.mockResolvedValue({ data: { success: true } }); mount(); await openIt()
    fireEvent.click(screen.getByRole('button', { name: /cancel for a full refund/i })); expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /keep my order/i })); expect(api.post).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /cancel for a full refund/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /cancel for a full refund/i })); fireEvent.click(screen.getByRole('button', { name: /yes, cancel and refund/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/o1/cancel'))
  })
  it('B2 accepting a delivery says it uses up the revision, and only then sends', async () => {
    serve(order({ state: 'delivered', canAccept: true, canRevise: true, delivery: { files: {}, confirmations: [], summary: '' } })); api.post.mockResolvedValue({ data: { success: true } }); mount(); await openIt()
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i })); expect(api.post).not.toHaveBeenCalled(); expect(screen.getByRole('alertdialog').textContent).toMatch(/uses up your one included revision/)
    fireEvent.click(screen.getByRole('button', { name: /yes, accept/i })); await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/o1/accept'))
  })
  it('B5 no "expected by" line of its own: a cancelled, refunded, accepted or delivered order never shows an old deadline', async () => {
    for (const state of ['cancelled', 'refunded', 'accepted', 'delivered']) {
      serve(order({ state })); const { unmount } = mount(); await openIt(); expect(screen.queryByText(/expected by/i), state).toBeNull(); unmount()
    }
  })
  it('B5 in a revision the one deadline shown is the revision deadline, in the tracker', async () => {
    serve(order({ state: 'revision', revisionDueAt: '2026-11-12T10:00:00Z' })); mount(); await openIt()
    expect(screen.getAllByText(/expected by/i)).toHaveLength(1); expect(screen.getByLabelText('Order progress').textContent).toMatch(/November 12, 2026|12 November 2026/)
  })
  it('B11 a failed load shows its error and not "no orders"', async () => {
    api.get.mockRejectedValue({ response: { data: { message: 'We could not load your orders.' } } }); mount()
    await screen.findByText(/could not load your orders/i); expect(screen.queryByText(/no human rewrite orders/i)).toBeNull()
  })
  it('G1 an unpaid order can be paid from here: it opens the checkout the server hands back', async () => {
    serve(order({ state: 'awaiting_payment', promisedAt: null })); api.post.mockResolvedValue({ data: { success: true, data: { authorizationUrl: 'https://checkout.paystack.com/AC1' } } })
    mount(); await openIt(); fireEvent.click(screen.getByRole('button', { name: /pay \$89 now/i }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/o1/pay')); await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.paystack.com/AC1'))
  })
  it('G1 when the payment can no longer be opened the server\'s words are shown', async () => {
    serve(order({ state: 'awaiting_payment', promisedAt: null })); api.post.mockRejectedValue({ response: { data: { message: 'This payment can no longer be opened. Please start a new order from your scan.' } } })
    mount(); await openIt(); fireEvent.click(screen.getByRole('button', { name: /now/i })); expect(await screen.findByText(/start a new order/i)).toBeTruthy(); expect(assign).not.toHaveBeenCalled()
  })
  it('G2 materials: listed, removable, and files or links can be added while the server allows it; hidden once an expert has the order', async () => {
    const o = order({ canEditMaterials: true, materials: [{ id: 'm1', kind: 'file', label: 'cv.pdf', status: 'ready' }, { id: 'm2', kind: 'link', label: 'site', url: 'https://x.test/p', status: 'ready' }] })
    serve(o); api.delete.mockResolvedValue({ data: { success: true } }); api.post.mockResolvedValue({ data: { success: true } }); mount(); await openIt()
    expect(screen.getByText('cv.pdf')).toBeTruthy(); expect(screen.getByText('https://x.test/p')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove cv.pdf' })); await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/human/orders/o1/materials/m1'))
    fireEvent.change(screen.getByLabelText('Add a link'), { target: { value: 'https://new.test' } }); fireEvent.click(screen.getByRole('button', { name: 'Add link' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/o1/links', { url: 'https://new.test' }))
    const file = new File(['x'], 'extra.pdf', { type: 'application/pdf' }); fireEvent.change(screen.getByLabelText('Add a file'), { target: { files: [file] } })
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/human/orders/o1/materials', expect.any(FormData), expect.anything()))
    cleanup(); serve(order({ state: 'in_progress', canEditMaterials: false, materials: [{ id: 'm1', kind: 'file', label: 'cv.pdf', status: 'ready' }] })); mount(); await openIt()
    expect(screen.queryByLabelText('Add a file')).toBeNull()
  })
  it('G3 ?order= opens that order (the link shown when a second order is refused)', async () => {
    serve(order()); mount('/human/orders?order=o1'); expect(await screen.findByLabelText('Order progress')).toBeTruthy()
  })
  it('G4 the page refreshes itself while an order can still change (not while the tab is hidden), and stops when every order is finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); let state = 'in_progress'; let lists = 0
    api.get.mockImplementation(async url => { if (url === '/human/orders') { lists++; return ok({ orders: [order({ state })] }) } return ok(order({ state })) })
    mount(); await openIt(); const base = lists
    await act(async () => { await vi.advanceTimersByTimeAsync(61000) }); expect(lists).toBeGreaterThan(base)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); const hiddenBase = lists
    await act(async () => { await vi.advanceTimersByTimeAsync(61000) }); expect(lists).toBe(hiddenBase)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); state = 'accepted'
    await act(async () => { await vi.advanceTimersByTimeAsync(61000) }); const finished = lists
    await act(async () => { await vi.advanceTimersByTimeAsync(180000) }); expect(lists).toBe(finished)
  })
  it('G4 a question the expert asks while the page is open appears without a reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); let questions = []
    api.get.mockImplementation(async url => url === '/human/orders' ? ok({ orders: [order({ state: 'in_progress' })] }) : ok(order({ state: 'in_progress', questions })))
    mount(); await openIt(); expect(screen.queryByText(/The expert asks/)).toBeNull()
    questions = [{ id: 'q1', body: 'Which role?', status: 'pending' }]
    await act(async () => { await vi.advanceTimersByTimeAsync(61000) }); expect(await screen.findByText(/The expert asks: Which role\?/)).toBeTruthy()
  })
})

describe('A11 checkout page', () => {
  const CFG = { available: true, currency: 'USD', tiers: [{ tier: 'seven_day', label: '7-day', priceCents: 8900, turnaroundHours: 168 }], coverLetterCents: 2900,
    wording: { termsConsent: 'T', age: 'A', rights: 'R', learning: 'L', privacy: 'P', refunds: 'RF', terms: 'TT' }, regions: ['US'], tones: ['balanced'], materials: { maxFiles: 3, maxBytes: 5242880 }, acceptHours: 72 }
  it('G3 when a second order for the same resume is refused, the message links to the existing order', async () => {
    api.get.mockResolvedValue(ok(CFG)); api.post.mockRejectedValue({ response: { status: 409, data: { code: 'ALREADY_ORDERED', orderId: 'o9', message: 'You already have a human order for this resume.' } } })
    render(<MemoryRouter initialEntries={['/human/order?scanId=s1']}><HumanOrder /></MemoryRouter>)
    fireEvent.click(await screen.findByLabelText(/7-day/)); fireEvent.change(screen.getByLabelText('Target role'), { target: { value: 'PM' } })
    for (const l of ['T', 'A', 'R']) fireEvent.click(screen.getByLabelText(l))
    fireEvent.click(screen.getByRole('button', { name: /continue|pay|order/i }))
    const link = await screen.findByRole('link', { name: /see that order/i }); expect(link.getAttribute('href')).toBe('/human/orders?order=o9')
  })
})
