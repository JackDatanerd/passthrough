// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminLeads from '../../src/pages/admin/AdminLeads'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (e, fallback) => e?.response?.data?.message || fallback,
}))

// Independent audit round 6 (Section 5): the admin side of "notify confirmed leads when there are
// Verified candidates" (G1) and the warning for a capped CSV export (G3).
const list = (candidateSupply = { sales: 3 }) => ({ data: { success: true, data: [], meta: {
  page: 1, pageSize: 25, total: 0, counts: { NEW: 0, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: 0 },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply } } })
const renderAt = (url) => render(<MemoryRouter initialEntries={[url]}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset() })

describe('AdminLeads — notify confirmed leads', () => {
  it('offers the action only once a real field is chosen', async () => {
    api.get.mockResolvedValue(list())
    renderAt('/admin/leads')
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Notify .* leads/ })).toBeNull()
  })

  it('does a dry run first, asks to confirm, then sends and reports the outcome', async () => {
    api.get.mockResolvedValue(list())
    api.post
      .mockResolvedValueOnce({ data: { success: true, data: { field: 'sales', candidates: 3, eligible: 2, sent: 0, failed: 0, remaining: 2, dryRun: true } } })
      .mockResolvedValueOnce({ data: { success: true, data: { field: 'sales', candidates: 3, eligible: 2, sent: 2, failed: 0, remaining: 0 } } })
    renderAt('/admin/leads?field=sales')
    await userEvent.click(await screen.findByRole('button', { name: 'Notify Sales leads' }))
    expect(api.post).toHaveBeenNthCalledWith(1, '/employer-leads/notify-candidates', { field: 'sales', dryRun: true })
    expect(await screen.findByText(/Email 2 of 2 confirmed leads in Sales that there are 3 Verified candidates now/)).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledTimes(1)   // nothing sent before the confirm
    await userEvent.click(screen.getByRole('button', { name: 'Send emails' }))
    await waitFor(() => expect(api.post).toHaveBeenNthCalledWith(2, '/employer-leads/notify-candidates', { field: 'sales' }))
    expect(await screen.findByText('Emailed 2 leads.')).toBeInTheDocument()
  })

  it('says so, without a dialog, when nobody is waiting to be told', async () => {
    api.get.mockResolvedValue(list())
    api.post.mockResolvedValueOnce({ data: { success: true, data: { field: 'sales', candidates: 3, eligible: 0, sent: 0, failed: 0, remaining: 0, dryRun: true } } })
    renderAt('/admin/leads?field=sales')
    await userEvent.click(await screen.findByRole('button', { name: 'Notify Sales leads' }))
    expect(await screen.findByText(/No confirmed, open Sales leads are waiting/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send emails' })).toBeNull()
  })

  it('is disabled while the field has no Verified candidates', async () => {
    api.get.mockResolvedValue(list({ sales: 0 }))
    renderAt('/admin/leads?field=sales')
    expect(await screen.findByRole('button', { name: 'Notify Sales leads' })).toBeDisabled()
  })
})

describe('AdminLeads — capped export', () => {
  it('warns when the server says the CSV was truncated', async () => {
    api.get.mockImplementation(async (url) => url.endsWith('export.csv')
      ? { data: new Blob(['x']), headers: { 'x-export-truncated': 'true', 'x-export-rows': '50000' } }
      : list())
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
    renderAt('/admin/leads')
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }))
    expect(await screen.findByText(/hit its 50,000-row limit and is incomplete/)).toBeInTheDocument()
  })

  it('stays quiet for a complete export', async () => {
    api.get.mockImplementation(async (url) => url.endsWith('export.csv')
      ? { data: new Blob(['x']), headers: { 'x-export-truncated': 'false', 'x-export-rows': '12' } }
      : list())
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
    renderAt('/admin/leads')
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled())
    expect(screen.queryByText(/incomplete/)).toBeNull()
  })
})
