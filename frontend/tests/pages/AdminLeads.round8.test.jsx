// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminLeads from '../../src/pages/admin/AdminLeads'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (e, fallback) => e?.response?.data?.message || fallback,
}))

// Independent audit round 8 (Section 5): delete-and-block, the new bulk actions, and the notify toast.
const lead = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: null, roleTitle: null,
  source: 'homepage', sourceCode: null, status: 'NEW', notes: '', submissionCount: 1, lastSubmittedAt: '2026-01-01T00:00:00.000Z',
  contactedAt: null, confirmedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', ...over,
})
const list = (leads, candidateSupply = { sales: 3 }) => ({ data: { success: true, data: leads, meta: {
  page: 1, pageSize: 25, total: leads.length, counts: { NEW: leads.length, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: leads.length },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply } } })
const renderAt = (url = '/admin/leads') => render(<MemoryRouter initialEntries={[url]}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.delete.mockReset() })

describe('AdminLeads — delete and block', () => {
  it('a plain delete sends no suppress flag', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.delete.mockResolvedValue({ data: { success: true } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('checkbox', { name: /Also block this address/ })).not.toBeChecked()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1))
    expect(api.delete).toHaveBeenCalledWith('/employer-leads/11111111-1111-4111-8111-111111111111')
  })

  it('ticking the box sends ?suppress=true, and the box is cleared for the next delete', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.delete.mockResolvedValue({ data: { success: true } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Also block this address/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/employer-leads/11111111-1111-4111-8111-111111111111', { params: { suppress: true } }))
    expect(await screen.findByText('Lead deleted and its address blocked.')).toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('checkbox', { name: /Also block this address/ })).not.toBeChecked()
  })

  it('bulk delete becomes deleteAndSuppress when the box is ticked', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true, affected: 1 } })
    renderAt()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select dana@acme.com' }))
    const bar = screen.getByText('1 selected').parentElement
    await userEvent.click(within(bar).getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Also block these addresses/ }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', { ids: ['11111111-1111-4111-8111-111111111111'], action: 'deleteAndSuppress' }))
  })
})

describe('AdminLeads — more bulk actions', () => {
  const selectFirst = async () => {
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select dana@acme.com' }))
    return screen.getByText('1 selected').parentElement
  }

  it('sets the field of the selected leads (and "No field" clears it)', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true, affected: 1 } })
    renderAt()
    const bar = await selectFirst()
    await userEvent.selectOptions(within(bar).getByLabelText('Set field for selected leads'), 'sales')
    await userEvent.click(within(bar).getByRole('button', { name: 'Set field' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', { ids: expect.any(Array), action: 'setField', field: 'sales' }))
    await userEvent.selectOptions(within(bar).getByLabelText('Set field for selected leads'), '')
    await userEvent.click(within(bar).getByRole('button', { name: 'Set field' }))
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/employer-leads/bulk', { ids: expect.any(Array), action: 'setField', field: null }))
  })

  it('asks before marking the selection confirmed', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true, affected: 1 } })
    renderAt()
    const bar = await selectFirst()
    await userEvent.click(within(bar).getByRole('button', { name: 'Mark confirmed' }))
    expect(api.post).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark confirmed' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', { ids: expect.any(Array), action: 'markConfirmed' }))
  })

  it('requests confirmation and reports sent, failed and already-confirmed', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true, affected: 2, sent: 2, failed: 1, skipped: 3 } })
    renderAt()
    const bar = await selectFirst()
    await userEvent.click(within(bar).getByRole('button', { name: 'Request confirmation' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', { ids: expect.any(Array), action: 'requestConfirmation' }))
    expect(await screen.findByText(/Confirmation sent to 2 leads; 1 could not be sent .*; 3 skipped \(already confirmed, or no longer there\)\./)).toBeInTheDocument()
  })

  it('will not offer to mail more than 25 at once', async () => {
    const many = Array.from({ length: 26 }, (_, i) => lead({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `l${i}@acme.com` }))
    api.get.mockResolvedValue({ data: { ...list(many).data, meta: { ...list(many).data.meta, total: 26 } } })
    renderAt()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all leads on this page' }))
    const bar = screen.getByText('26 selected').parentElement
    expect(within(bar).getByRole('button', { name: 'Request confirmation' })).toBeDisabled()
  })
})

describe('AdminLeads — notify toast', () => {
  it('reports skipped and failed leads separately, and does not tell you to press again for them', async () => {
    api.get.mockResolvedValue(list([]))
    api.post
      .mockResolvedValueOnce({ data: { success: true, data: { field: 'sales', candidates: 3, eligible: 4, sent: 0, failed: 0, remaining: 4, dryRun: true } } })
      .mockResolvedValueOnce({ data: { success: true, data: { field: 'sales', candidates: 3, eligible: 4, sent: 2, failed: 1, skipped: 1, remaining: 0 } } })
    renderAt('/admin/leads?field=sales')
    await userEvent.click(await screen.findByRole('button', { name: 'Notify Sales leads' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Send emails' }))
    const toastText = await screen.findByText(/^Emailed 2 leads; 1 skipped/)
    expect(toastText.textContent).toMatch(/1 could not be sent — they will be tried again next time/)
    expect(toastText.textContent).not.toMatch(/press the button again/)
  })
})
