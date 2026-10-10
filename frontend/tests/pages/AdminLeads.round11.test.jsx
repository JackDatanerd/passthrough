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

// Round 11: mail-suppression note, "select all matching", add-mode extras, edit-mode override, provenance.
const ID = '11111111-1111-4111-8111-111111111111'
const lead = (over = {}) => ({
  id: ID, name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: 'sales', roleTitle: null, extraRoleCategories: [],
  source: 'homepage', sourceCode: null, status: 'NEW', notes: '', submissionCount: 1, lastSubmittedAt: '2026-01-01T00:00:00.000Z',
  contactedAt: null, confirmedAt: '2026-01-02T00:00:00.000Z', confirmedVia: 'link', lastAckAt: null, ackAttempts: 0, archivedResubmittedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
})
const list = (leads, meta = {}) => ({ data: { success: true, data: leads, meta: {
  page: 1, pageSize: 25, total: leads.length, counts: { NEW: leads.length, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: leads.length },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply: { sales: 3 }, neverEmailed: 0, reengaged: 0, ...meta } } })
const renderAt = (url = '/admin/leads') => render(<MemoryRouter initialEntries={[url]}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)
const httpError = (status, code, message) => Object.assign(new Error('x'), { response: { status, data: { code, message } } })

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.delete.mockReset() })

async function openSuppression(checkData) {
  api.get.mockResolvedValue(list([lead()]))
  api.post.mockResolvedValueOnce({ data: { success: true, data: checkData } })
  renderAt()
  await userEvent.click(await screen.findByRole('button', { name: /Do-not-contact/ }))
  const dialog = screen.getByRole('dialog')
  await userEvent.type(within(dialog).getByLabelText('Email'), 'bounce@x.com')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Check' }))
  return dialog
}

describe('AdminLeads — mail suppression in the do-not-contact modal', () => {
  it('shows the note and lifts both lists with includeMailSuppression', async () => {
    const dialog = await openSuppression({ suppressed: true, since: '2026-01-01T00:00:00.000Z', leadExists: false, mailSuppression: { reason: 'bounce', since: '2026-02-01T00:00:00.000Z' } })
    expect(await within(dialog).findByText(/blocked from ALL our email/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Nothing we send will reach it/)).toBeInTheDocument()
    api.delete.mockResolvedValue({ data: { success: true, data: { listLifted: true, mailLifted: true } } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lift this block too' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/employer-leads/suppressions', { data: { email: 'bounce@x.com', includeMailSuppression: true } }))
    expect(await screen.findByText('Do-not-contact entry and email block both lifted.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/blocked from ALL our email/)).toBeNull()
  })

  it('the plain Lift still sends only the email, and leaves the mail block showing', async () => {
    const dialog = await openSuppression({ suppressed: true, since: '2026-01-01T00:00:00.000Z', mailSuppression: { reason: 'bounce', since: '2026-02-01T00:00:00.000Z' } })
    api.delete.mockResolvedValue({ data: { success: true, data: { listLifted: true, mailLifted: false } } })
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Lift suppression' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/employer-leads/suppressions', { data: { email: 'bounce@x.com' } }))
    expect(within(dialog).getByText(/blocked from ALL our email/)).toBeInTheDocument()
  })

  it('asks for an extra confirmation before lifting a spam-complaint block', async () => {
    const dialog = await openSuppression({ suppressed: false, since: null, leadExists: false, mailSuppression: { reason: 'complaint', since: '2026-02-01T00:00:00.000Z' } })
    api.delete.mockResolvedValue({ data: { success: true, data: { listLifted: false, mailLifted: true } } })
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Lift this block too' }))
    expect(api.delete).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/only lift if they asked/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, lift this block too' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/employer-leads/suppressions', { data: { email: 'bounce@x.com', includeMailSuppression: true } }))
    expect(await screen.findByText('Email block lifted.')).toBeInTheDocument()
  })
})

describe('AdminLeads — select all matching', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => lead({ id: `id-${i}`, email: `l${i}@x.com`, name: `L${i}` }))
  async function engage(url = '/admin/leads?status=NEW&search=acme') {
    api.get.mockResolvedValue(list(many(25), { total: 60 }))
    renderAt(url)
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all leads on this page' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Select all 60 leads matching this filter' }))
  }

  it('offers the banner only when the page is fully selected and more exist', async () => {
    api.get.mockResolvedValue(list(many(25), { total: 25 }))
    renderAt()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all leads on this page' }))
    expect(screen.queryByRole('button', { name: /leads matching this filter/ })).toBeNull()
  })

  it('sends the filter and expected total, and hides request-confirmation', async () => {
    await engage()
    expect(screen.getByText(/All 60 leads matching this filter are selected/)).toBeInTheDocument()
    expect(screen.getByText('All 60 matching leads selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request confirmation' })).toBeDisabled()
    api.post.mockResolvedValue({ data: { success: true, affected: 60 } })
    await userEvent.click(screen.getByRole('button', { name: 'Set status' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', {
      filter: { search: 'acme', status: 'NEW' }, expected: 60, action: 'setStatus', status: 'CONTACTED',
    }))
    expect(await screen.findByText('Status updated (60).')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('All 60 matching leads selected')).toBeNull())
  })

  it('the delete dialog names all the matching leads and sends deleteAndSuppress with the filter', async () => {
    await engage()
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])   // the toolbar's, above the rows
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/Delete all 60 matching leads\?/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('checkbox'))
    api.post.mockResolvedValue({ data: { success: true, affected: 60 } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/bulk', expect.objectContaining({ filter: { search: 'acme', status: 'NEW' }, expected: 60, action: 'deleteAndSuppress' })))
    expect(api.post.mock.calls.at(-1)[1]).not.toHaveProperty('ids')
  })

  it('surfaces LIST_CHANGED and leaves the mode', async () => {
    await engage()
    api.post.mockRejectedValue(httpError(409, 'LIST_CHANGED', 'The list changed — reload and try again.'))
    await userEvent.click(screen.getByRole('button', { name: 'Set status' }))
    expect(await screen.findByText('The list changed — reload and try again.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('All 60 matching leads selected')).toBeNull())
  })

  it('Clear selection and a filter change both end the mode', async () => {
    await engage()
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByText('All 60 matching leads selected')).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all leads on this page' }))
    await userEvent.click(screen.getByRole('button', { name: 'Select all 60 leads matching this filter' }))
    await userEvent.click(screen.getByRole('button', { name: /^CONTACTED/ }))
    await waitFor(() => expect(screen.queryByText('All 60 matching leads selected')).toBeNull())
  })
})

describe('AdminLeads — add and edit lead form', () => {
  it('add mode offers the other-fields group and posts extraRoleCategories without the primary', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Add lead' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Also hiring in (up to 4)')).toBeNull()
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Eve')
    await userEvent.type(within(dialog).getByLabelText('Company'), 'Co')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'eve@co.com')
    await userEvent.selectOptions(within(dialog).getByLabelText('Field'), 'sales')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Design' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Finance' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add lead' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/employer-leads/manual', expect.objectContaining({ roleCategory: 'sales', extraRoleCategories: ['design', 'finance'] })))
  })

  it('add mode drops an extra that became the primary field', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.post.mockResolvedValue({ data: { success: true } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Add lead' }))
    const dialog = screen.getByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Eve')
    await userEvent.type(within(dialog).getByLabelText('Company'), 'Co')
    await userEvent.type(within(dialog).getByLabelText('Email'), 'eve@co.com')
    await userEvent.selectOptions(within(dialog).getByLabelText('Field'), 'sales')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Design' }))
    await userEvent.selectOptions(within(dialog).getByLabelText('Field'), 'design')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add lead' }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1]).not.toHaveProperty('extraRoleCategories')
  })

  it('edit mode: the add-anyway button resends the PATCH with overrideRemoval', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.patch.mockRejectedValueOnce(httpError(409, 'REMOVAL_REQUESTED', 'That address asked to be removed.'))
      .mockResolvedValueOnce({ data: { success: true, data: lead() } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    const email = within(dialog).getByLabelText('Email')
    await userEvent.clear(email); await userEvent.type(email, 'gone@x.com')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /add anyway/ }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2))
    expect(api.patch.mock.calls[0][1]).not.toHaveProperty('overrideRemoval')
    expect(api.patch.mock.calls[1][1]).toMatchObject({ email: 'gone@x.com', overrideRemoval: true })
  })
})

describe('AdminLeads — provenance and bulk mail toast', () => {
  it('labels how an address was confirmed', async () => {
    api.get.mockResolvedValue(list([
      lead({ id: 'a', email: 'a@x.com', name: 'A', confirmedVia: 'admin' }),
      lead({ id: 'b', email: 'b@x.com', name: 'B', confirmedVia: 'rejoin' }),
      lead({ id: 'c', email: 'c@x.com', name: 'C', confirmedVia: 'import' }),
      lead({ id: 'd', email: 'd@x.com', name: 'D', confirmedVia: 'manual' }),
    ]))
    renderAt()
    expect(await screen.findByText(/marked by admin/)).toBeInTheDocument()
    expect(screen.getByText(/re-joined via email/)).toBeInTheDocument()
    expect(screen.getByText(/imported/)).toBeInTheDocument()
    expect(screen.getByText(/added by admin/)).toBeInTheDocument()
  })

  it('bulk request-confirmation mentions blocked addresses', async () => {
    api.get.mockResolvedValue(list([lead({ confirmedAt: null, confirmedVia: null })]))
    api.post.mockResolvedValue({ data: { success: true, sent: 0, failed: 0, skipped: 0, blocked: 2 } })
    renderAt()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select dana@acme.com' }))
    await userEvent.click(screen.getByRole('button', { name: 'Request confirmation' }))
    expect(await screen.findByText(/2 blocked \(address bounced or reported spam\)/)).toBeInTheDocument()
  })
})
