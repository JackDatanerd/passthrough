// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import PaymentHistory from '../../src/pages/dashboard/PaymentHistory'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/layout/DashboardLayout', () => ({ default: ({ children }) => <div>{children}</div> }))

// Payments & Pricing round 2: B1 (pagination — the page used to keep only the
// first 20 rows), G1 (receipt resend), G3 (unfinished-checkout toggle), G5
// (cancel a PENDING checkout from the history).
const pay = (i, over = {}) => ({
  id: `p${i}`, amountCents: 4900, currency: 'USD', status: 'SUCCESS', paystackRef: `ref${i}`,
  createdAt: '2026-09-27T10:00:00Z', scanId: `s${i}`, fixTier: 'FIX', receiptAvailable: true, ...over,
})
const respond = (payments, total = payments.length) => ({ data: { data: { payments, total, page: 1, pageSize: 20 } } })
const renderPage = () => render(<MemoryRouter><PaymentHistory /></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('PaymentHistory', () => {
  it('requests an explicit page 1 of 20, without includeAbandoned', async () => {
    api.get.mockResolvedValue(respond([pay(1)]))
    renderPage()
    await screen.findByText('Fix + Credential')
    expect(api.get).toHaveBeenCalledWith('/payments/history', { params: { page: 1, pageSize: 20, includeAbandoned: undefined } })
  })

  it('B1: shows pagination when there are more than 20 payments, and Next requests page 2', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(respond(Array.from({ length: 20 }, (_, i) => pay(i)), 45))
    renderPage()
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')
    expect(api.get).toHaveBeenLastCalledWith('/payments/history', { params: { page: 2, pageSize: 20, includeAbandoned: undefined } })
  })

  it('a single page shows no pagination controls', async () => {
    api.get.mockResolvedValue(respond([pay(1)], 1))
    renderPage()
    await screen.findByText('Fix + Credential')
    expect(screen.queryByText(/Page \d+ of/)).toBeNull()
  })

  it('G3: ticking "Show unfinished checkouts" refetches from page 1 with includeAbandoned=1', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(respond(Array.from({ length: 20 }, (_, i) => pay(i)), 45))
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')
    await user.click(screen.getByLabelText('Show unfinished checkouts'))
    await screen.findByText('Page 1 of 3')
    expect(api.get).toHaveBeenLastCalledWith('/payments/history', { params: { page: 1, pageSize: 20, includeAbandoned: 1 } })
  })

  it('shows the empty state', async () => {
    api.get.mockResolvedValue(respond([]))
    renderPage()
    expect(await screen.findByText(/No payments yet/)).toBeInTheDocument()
  })

  it('shows the load error', async () => {
    api.get.mockRejectedValue({ response: { data: { message: 'boom' } } })
    renderPage()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  describe('G1: receipt resend', () => {
    it('offers "Email receipt" only on rows the server flags receiptAvailable', async () => {
      api.get.mockResolvedValue(respond([pay(1), pay(2, { receiptAvailable: false, status: 'PENDING' })]))
      renderPage()
      await screen.findAllByText('Fix + Credential')
      expect(screen.getAllByRole('button', { name: 'Email receipt' })).toHaveLength(1)
    })

    it('posts to the receipt endpoint and shows the server\'s confirmation on that row', async () => {
      const user = userEvent.setup()
      api.get.mockResolvedValue(respond([pay(1)]))
      api.post.mockResolvedValue({ data: { success: true, message: 'Receipt sent to a@b.co.' } })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Email receipt' }))
      expect(api.post).toHaveBeenCalledWith('/payments/ref1/receipt')
      expect(await screen.findByText('Receipt sent to a@b.co.')).toBeInTheDocument()
    })

    it('shows the server\'s reason when the receipt could not be sent (e.g. rate limited)', async () => {
      const user = userEvent.setup()
      api.get.mockResolvedValue(respond([pay(1)]))
      api.post.mockRejectedValue({ response: { data: { message: 'Receipt already sent a few times. Please try again in an hour.' } } })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Email receipt' }))
      expect(await screen.findByText(/try again in an hour/)).toBeInTheDocument()
    })
  })

  describe('G5: cancel a PENDING checkout', () => {
    it('offers "Cancel checkout" only on PENDING rows', async () => {
      api.get.mockResolvedValue(respond([pay(1), pay(2, { status: 'PENDING', receiptAvailable: false })]))
      renderPage()
      await screen.findAllByText('Fix + Credential')
      expect(screen.getAllByRole('button', { name: 'Cancel checkout' })).toHaveLength(1)
    })

    it('asks first, then posts the cancel and reloads', async () => {
      const user = userEvent.setup()
      api.get.mockResolvedValue(respond([pay(2, { status: 'PENDING', receiptAvailable: false })]))
      api.post.mockResolvedValue({ data: { success: true } })
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Cancel checkout' }))
      expect(api.post).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByText(/If you have already paid, do not cancel/)).toBeInTheDocument()
      await user.click(within(dialog).getByRole('button', { name: 'Cancel checkout' }))
      expect(api.post).toHaveBeenCalledWith('/payments/ref2/cancel')
      await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    })

    it('"Keep it" closes the dialog without cancelling', async () => {
      const user = userEvent.setup()
      api.get.mockResolvedValue(respond([pay(2, { status: 'PENDING', receiptAvailable: false })]))
      renderPage()
      await user.click(await screen.findByRole('button', { name: 'Cancel checkout' }))
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep it' }))
      expect(api.post).not.toHaveBeenCalled()
    })
  })
})
