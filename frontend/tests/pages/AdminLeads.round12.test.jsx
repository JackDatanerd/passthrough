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

// Round 12: do-not-contact flag, detail panel, import/rejoin sources, lift-failed retry.
const ID = '11111111-1111-4111-8111-111111111111'
const lead = (over = {}) => ({
  id: ID, name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: 'sales', roleTitle: null, extraRoleCategories: [],
  source: 'homepage', sourceCode: null, status: 'NEW', notes: '', submissionCount: 1, lastSubmittedAt: '2026-01-01T00:00:00.000Z',
  contactedAt: null, confirmedAt: '2026-01-02T00:00:00.000Z', confirmedVia: 'link', lastAckAt: null, ackAttempts: 0, archivedResubmittedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', doNotContact: false, ...over,
})
const list = (leads) => ({ data: { success: true, data: leads, meta: {
  page: 1, pageSize: 25, total: leads.length, counts: { NEW: leads.length, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: leads.length },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply: { sales: 3 }, neverEmailed: 0, reengaged: 0 } } })
const renderAt = (url = '/admin/leads') => render(<MemoryRouter initialEntries={[url]}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)
const httpError = (status, code, message) => Object.assign(new Error('x'), { response: { status, data: { code, message } } })

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.delete.mockReset() })

describe('AdminLeads — round 12', () => {
  it('flags a row whose address is on the do-not-contact list', async () => {
    api.get.mockResolvedValue(list([lead({ doNotContact: true })]))
    renderAt()
    expect(await screen.findByText('do not contact')).toBeInTheDocument()
  })
  it('offers the import and re-joined sources in the filter', async () => {
    api.get.mockResolvedValue(list([lead()]))
    renderAt()
    await screen.findByText('Dana')
    expect(screen.getByRole('option', { name: 'CSV import (0)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Re-joined (0)' })).toBeInTheDocument()
  })
  it('opens the detail panel and shows status, mail history and same-inbox leads', async () => {
    api.get.mockImplementation(async (url) => {
      if (url === `/employer-leads/${ID}`) return { data: { success: true, data: {
        lead: lead({ candidatesNotifiedFields: { sales: '2026-02-01T00:00:00.000Z' } }),
        doNotContact: { suppressed: true, reason: 'admin', since: '2026-01-05T00:00:00.000Z' }, mailSuppression: null,
        emails: [{ template: 'employer_lead_ack', subject: 'Confirm your email', status: 'sent', sentAt: '2026-01-01T01:00:00.000Z' }],
        sameInbox: [{ id: 'x', name: 'Dana J', email: 'dana+jobs@acme.com', status: 'NEW' }] } } }
      return list([lead()])
    })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/On the do-not-contact list \(admin\)/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Confirm your email/)).toBeInTheDocument()
    expect(within(dialog).getByText(/dana\+jobs@acme.com/)).toBeInTheDocument()
  })
  it('after REMOVAL_LIFT_FAILED the same dialog retries with the address and overrideRemoval', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.patch.mockRejectedValueOnce(httpError(409, 'REMOVAL_LIFT_FAILED', 'The lead was saved, but its address could not be taken off the do-not-contact list. Try again.'))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    const email = within(dialog).getByLabelText('Email')
    await userEvent.clear(email); await userEvent.type(email, 'new@acme.com')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const retry = await within(dialog).findByRole('button', { name: 'Try lifting the block again' })
    api.patch.mockResolvedValueOnce({ data: { success: true } })
    await userEvent.click(retry)
    await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith(`/employer-leads/${ID}`, expect.objectContaining({ email: 'new@acme.com', overrideRemoval: true })))
  })
})
