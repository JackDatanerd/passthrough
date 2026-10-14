// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminLeads from '../../src/pages/admin/AdminLeads'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (e, fallback) => e?.response?.data?.message || fallback,
}))

// Round 16: the screens for the round-15 backend features — "add it anyway" for a same-inbox duplicate, the merge preview,
// and the import summary's same-inbox count.
const ID = '11111111-1111-4111-8111-111111111111'
const lead = (over = {}) => ({
  id: ID, name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: 'sales', roleTitle: null, extraRoleCategories: [],
  source: 'homepage', sourceCode: null, status: 'NEW', notes: '', submissionCount: 1, lastSubmittedAt: '2026-01-01T00:00:00.000Z',
  contactedAt: null, confirmedAt: '2026-01-02T00:00:00.000Z', confirmedVia: 'link', lastAckAt: null, ackAttempts: 0, archivedResubmittedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', doNotContact: false, ...over,
})
const list = (leads) => ({ data: { success: true, data: leads, meta: {
  page: 1, pageSize: 25, total: leads.length, counts: { NEW: leads.length, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: leads.length },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply: { sales: 3 }, neverEmailed: 0, reengaged: 0 } } })
const renderAt = () => render(<MemoryRouter initialEntries={['/admin/leads']}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)
const httpError = (status, code, message) => Object.assign(new Error('x'), { response: { status, data: { code, message } } })

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.delete.mockReset() })

describe('same-inbox duplicate: "add it anyway" (manual add) and "use this address anyway" (edit)', () => {
  it('add: a DUPLICATE_MAILBOX refusal offers the button, which resends with allowDuplicate', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockRejectedValueOnce(httpError(409, 'DUPLICATE_MAILBOX', 'dana@acme.com is already a lead for this same mailbox.'))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Add lead' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Dana')
    await userEvent.type(within(dialog).getByLabelText('Company'), 'Acme')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'dana+x@acme.com')
    expect(within(dialog).queryByRole('button', { name: 'Add it anyway' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add lead' }))
    expect(await within(dialog).findByText(/already a lead for this same mailbox/)).toBeInTheDocument()
    expect(api.post.mock.calls[0][1].allowDuplicate).toBeUndefined()
    api.post.mockResolvedValueOnce({ data: { success: true } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add it anyway' }))
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/employer-leads/manual', expect.objectContaining({ email: 'dana+x@acme.com', allowDuplicate: true })))
  })
  it('edit: the same refusal on a changed address offers "Use this address anyway"', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.patch.mockRejectedValueOnce(httpError(409, 'DUPLICATE_MAILBOX', 'x is already a lead for this same mailbox.'))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    const email = within(dialog).getByLabelText('Email')
    await userEvent.clear(email); await userEvent.type(email, 'dana+x@acme.com')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const again = await within(dialog).findByRole('button', { name: 'Use this address anyway' })
    api.patch.mockResolvedValueOnce({ data: { success: true } })
    await userEvent.click(again)
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith(`/employer-leads/${ID}`, expect.objectContaining({ email: 'dana+x@acme.com', allowDuplicate: true })))
  })
})

describe('Duplicates: merge is previewed first', () => {
  const groups = { data: { success: true, data: [{ mailbox: 'dana@acme.com', leads: [
    { id: ID, email: 'dana@acme.com', name: 'Dana', company: 'Acme', status: 'NEW', roleCategory: 'sales', confirmedAt: null, createdAt: '2026-01-01T00:00:00.000Z', submissionCount: 1 },
    { id: '22222222-2222-4222-8222-222222222222', email: 'dana+x@acme.com', name: 'Dana', company: 'Acme', status: 'NEW', roleCategory: 'design', confirmedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z', submissionCount: 2 },
  ] }], meta: { truncated: false } } }
  const open = async () => {
    api.get.mockImplementation(async (url) => url === '/employer-leads/duplicates' ? groups : list([lead()]))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicates' }))
    return screen.findByRole('dialog')
  }
  it('the first click asks for a dry run and shows the result and what would be lost; the second merges', async () => {
    const dialog = await open()
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: true, id: ID, merged: 1, droppedFields: ['legal'],
      result: { roleCategory: 'sales', extraRoleCategories: ['design'], status: 'NEW', confirmedAt: '2026-01-02T00:00:00.000Z', submissionCount: 3 } } } })
    await userEvent.click(await within(dialog).findByRole('button', { name: /^Preview: keep the selected/ }))
    const box = await within(dialog).findByTestId('merge-preview')
    expect(box).toHaveTextContent('3 submissions')
    expect(box).toHaveTextContent(/would be lost: .*Legal/)
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post.mock.calls[0][1].dryRun).toBe(true)
    api.post.mockResolvedValueOnce({ data: { success: true, data: { id: ID, merged: 1, droppedFields: ['legal'] } } })
    await userEvent.click(within(dialog).getByRole('button', { name: /^Confirm: merge 1 other/ }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[1][1].dryRun).toBeUndefined()
    expect(await screen.findByText(/did not fit and was dropped: Legal/)).toBeInTheDocument()
  })
  it('choosing a different lead to keep discards the preview (it described another outcome)', async () => {
    const dialog = await open()
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: true, droppedFields: [], result: { roleCategory: 'sales', extraRoleCategories: [], status: 'NEW', confirmedAt: null, submissionCount: 3 } } } })
    await userEvent.click(await within(dialog).findByRole('button', { name: /^Preview:/ }))
    await within(dialog).findByTestId('merge-preview')
    await userEvent.click(within(dialog).getAllByRole('radio')[1])
    expect(within(dialog).queryByTestId('merge-preview')).toBeNull()
    expect(within(dialog).getByRole('button', { name: /^Preview:/ })).toBeInTheDocument()
  })
})

describe('Import: same-inbox rows are counted in the summary', () => {
  it('shows them as skipped instead of "No problems found"', async () => {
    api.get.mockResolvedValue(list([lead()]))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }))
    const dialog = screen.getByRole('dialog')
    const text = 'name,company,email\nAnn,Acme,ann@acme.com\nAnn,Acme,ann+1@acme.com'
    const file = new File([text], 'leads.csv', { type: 'text/csv' }); if (!file.text) file.text = async () => text
    fireEvent.change(dialog.querySelector('input[type="file"]'), { target: { files: [file] } })
    await within(dialog).findByText(/2 rows found/)
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /asked to hear from Passthrough/ }))
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: true, rows: 2, created: 0, wouldCreate: 1, invalid: 0, duplicateInFile: 0, exists: 0, removed: 0, blocked: 0, alias: 1, fieldIgnored: 0,
      problems: [{ line: 2, email: 'ann+1@acme.com', reason: 'Same mailbox as ann@acme.com, earlier in this file.' }] } } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check file' }))
    expect(await within(dialog).findByText('1 would be imported, 1 skipped.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/No problems found/)).toBeNull()
    expect(within(dialog).getByText(/another spelling of an inbox that is already a lead/)).toBeInTheDocument()
  })
})
