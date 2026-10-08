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

// Independent audit round 10 (Section 5): the "never emailed" and "came back" views, editing the email
// and the other fields a lead is hiring in, and the CSV import dialog.
const ID = '11111111-1111-4111-8111-111111111111'
const lead = (over = {}) => ({
  id: ID, name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: 'sales', roleTitle: null, extraRoleCategories: [],
  source: 'homepage', sourceCode: null, status: 'NEW', notes: '', submissionCount: 1, lastSubmittedAt: '2026-01-01T00:00:00.000Z',
  contactedAt: null, confirmedAt: '2026-01-02T00:00:00.000Z', lastAckAt: null, ackAttempts: 0, archivedResubmittedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z', ...over,
})
const list = (leads, meta = {}) => ({ data: { success: true, data: leads, meta: {
  page: 1, pageSize: 25, total: leads.length, counts: { NEW: leads.length, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 0, OPEN: leads.length },
  sourceCounts: {}, unconfirmed: 0, suppressed: 0, candidateSupply: { sales: 3 }, neverEmailed: 0, reengaged: 0, ...meta } } })
const renderAt = (url = '/admin/leads') => render(<MemoryRouter initialEntries={[url]}><ToastProvider><AdminLeads /></ToastProvider></MemoryRouter>)

beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); api.delete.mockReset() })

describe('AdminLeads — needs-a-look views', () => {
  it('shows the "Never emailed" and "Came back" chips only when something is in them, with the counts', async () => {
    api.get.mockResolvedValue(list([lead()]))
    renderAt()
    await screen.findByText('Dana')
    expect(screen.queryByRole('button', { name: /Never emailed/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Came back while archived/ })).toBeNull()
    api.get.mockResolvedValue(list([lead()], { neverEmailed: 3, reengaged: 2 }))
    renderAt()
    expect(await screen.findByRole('button', { name: 'Never emailed (3)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Came back while archived (2)' })).toBeInTheDocument()
  })

  it('the chips send ack=never / reengaged=yes to the list', async () => {
    api.get.mockResolvedValue(list([lead()], { neverEmailed: 1, reengaged: 1 }))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Never emailed (1)' }))
    await waitFor(() => expect(api.get.mock.calls.some(([, o]) => o?.params?.ack === 'never')).toBe(true))
    await userEvent.click(screen.getByRole('button', { name: 'Came back while archived (1)' }))
    await waitFor(() => expect(api.get.mock.calls.some(([, o]) => o?.params?.reengaged === 'yes')).toBe(true))
  })

  it('an unconfirmed lead says whether its confirmation email went out', async () => {
    api.get.mockResolvedValue(list([
      lead({ id: 'a', email: 'a@x.com', name: 'A', confirmedAt: null, lastAckAt: null, ackAttempts: 2 }),
      lead({ id: 'b', email: 'b@x.com', name: 'B', confirmedAt: null, lastAckAt: '2026-02-01T00:00:00.000Z' }),
    ]))
    renderAt()
    expect(await screen.findByText(/no confirmation email sent \(2 retries failed\)/)).toBeInTheDocument()
    expect(screen.getByText(/confirmation sent/)).toBeInTheDocument()
  })

  it('an archived lead that came back says so; other fields are listed under the main one', async () => {
    api.get.mockResolvedValue(list([lead({ status: 'ARCHIVED', archivedResubmittedAt: '2026-03-01T00:00:00.000Z', extraRoleCategories: ['finance', 'design'] })]))
    renderAt()
    expect(await screen.findByText(/came back/)).toBeInTheDocument()
    expect(screen.getByText('also: Finance, Design')).toBeInTheDocument()
  })
})

describe('AdminLeads — editing the email and the other fields', () => {
  it('sends the email only when it changed, with the other fields, and says the new address was mailed', async () => {
    api.get.mockResolvedValue(list([lead({ extraRoleCategories: ['finance'] })]))
    api.patch.mockResolvedValue({ data: { success: true, data: lead(), confirmationReset: true } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    const email = within(dialog).getByLabelText('Email')
    expect(email).toHaveValue('dana@acme.com')
    await userEvent.clear(email); await userEvent.type(email, 'dana@acme.co')
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Design' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    expect(api.patch.mock.calls[0][1]).toMatchObject({ email: 'dana@acme.co', extraRoleCategories: ['finance', 'design'], roleCategory: 'sales' })
    expect(await screen.findByText(/new address was sent a confirmation link/)).toBeInTheDocument()
  })

  it('leaves the email out of the request when it was not touched, and never offers the main field as another', async () => {
    api.get.mockResolvedValue(list([lead()]))
    api.patch.mockResolvedValue({ data: { success: true, data: lead() } })
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('checkbox', { name: 'Sales' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    expect(api.patch.mock.calls[0][1]).not.toHaveProperty('email')
    expect(api.patch.mock.calls[0][1].extraRoleCategories).toEqual([])
  })

  it('stops offering fields at four', async () => {
    api.get.mockResolvedValue(list([lead({ extraRoleCategories: ['finance', 'design', 'legal', 'operations'] })]))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('checkbox', { name: 'Education' })).toBeDisabled()
    expect(within(dialog).getByRole('checkbox', { name: 'Legal' })).not.toBeDisabled()
  })
})

describe('AdminLeads — CSV import', () => {
  const csvFile = (text) => new File([text], 'leads.csv', { type: 'text/csv' })
  const open = async () => {
    api.get.mockResolvedValue(list([lead()]))
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Import CSV' }))
    return screen.getByRole('dialog')
  }
  const pick = async (dialog, text) => {
    const input = within(dialog).getByLabelText('CSV file')
    const file = csvFile(text)
    // jsdom's File has no text() on older versions
    if (!file.text) file.text = async () => text
    fireEvent.change(input, { target: { files: [file] } })
  }

  it('needs the attestation, checks the file without saving, then imports in batches', async () => {
    const dialog = await open()
    await pick(dialog, 'name,company,email\nAnn,Acme,ann@acme.com\nBob,Acme,bob@acme.com')
    expect(await within(dialog).findByText(/2 rows found/)).toBeInTheDocument()
    const check = within(dialog).getByRole('button', { name: 'Check file' })
    expect(check).toBeDisabled()
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /asked to hear from Passthrough/ }))
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: true, rows: 2, created: 0, wouldCreate: 2, invalid: 0, duplicateInFile: 0, exists: 0, removed: 0, fieldIgnored: 0, problems: [] } } })
    await userEvent.click(check)
    expect(await within(dialog).findByText('2 would be imported.')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/employer-leads/import', { rows: expect.any(Array), attest: true, dryRun: true })
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: false, rows: 2, created: 2, wouldCreate: 2, invalid: 0, duplicateInFile: 0, exists: 0, removed: 0, fieldIgnored: 0, problems: [] } } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 2' }))
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/employer-leads/import', expect.objectContaining({ attest: true, dryRun: false })))
    expect(await screen.findByText('2 leads imported.')).toBeInTheDocument()
  })

  it('explains a file with a missing column and keeps the buttons off', async () => {
    const dialog = await open()
    await pick(dialog, 'name,email\nAnn,ann@acme.com')
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/company/)
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /asked to hear from Passthrough/ }))
    expect(within(dialog).getByRole('button', { name: 'Check file' })).toBeDisabled()
  })

  it('lists the rows that would be skipped, with their reasons', async () => {
    const dialog = await open()
    await pick(dialog, 'name,company,email\nAnn,Acme,ann@acme.com')
    await within(dialog).findByText(/1 row found/)
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /asked to hear from Passthrough/ }))
    api.post.mockResolvedValueOnce({ data: { success: true, data: { dryRun: true, rows: 1, created: 0, wouldCreate: 0, invalid: 0, duplicateInFile: 0, exists: 1, removed: 0, fieldIgnored: 0, problems: [{ line: 1, email: 'ann@acme.com', reason: 'Already a lead.' }] } } })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check file' }))
    expect(await within(dialog).findByText(/Row 1 \(ann@acme.com\): Already a lead\./)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Import 0' })).toBeDisabled()
  })
})
