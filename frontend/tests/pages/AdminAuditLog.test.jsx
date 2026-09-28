// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminAuditLog from '../../src/pages/admin/AdminAuditLog'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() } }))

// Section 12 audit (feature gap): admin_audit_log was write-only — nothing
// ever read it back. This is the page that does; these pin its behaviour.
const entry = (i, over = {}) => ({
  id: `a${i}`, action: 'user.update', targetType: 'user', targetId: `t-${i}`,
  detail: { statusFrom: 'ACTIVE', statusTo: 'BANNED', scansReset: true, emailChanged: false },
  actorEmail: 'boss@x.co', createdAt: '2026-09-27T10:00:00Z', ...over,
})
const respond = (entries, total = entries.length) => ({ data: { data: entries, meta: { total } } })
const renderPage = () => render(<ToastProvider><AdminAuditLog /></ToastProvider>)

beforeEach(() => { api.get.mockReset() })

describe('AdminAuditLog', () => {
  it('loads page 1 with no filter and renders action, target, actor and detail', async () => {
    api.get.mockResolvedValue(respond([entry(1)]))
    renderPage()
    expect(await screen.findByText('user.update')).toBeInTheDocument()
    expect(api.get).toHaveBeenCalledWith('/admin/audit-log', { params: { page: 1, pageSize: 20, targetType: undefined } })
    expect(screen.getByText(/user · t-1/)).toBeInTheDocument()
    expect(screen.getByText(/boss@x\.co/)).toBeInTheDocument()
  })

  it('renders detail as readable key: value pairs (booleans as yes/no), not raw JSON', async () => {
    api.get.mockResolvedValue(respond([entry(1)]))
    renderPage()
    expect(await screen.findByText('statusFrom: ACTIVE · statusTo: BANNED · scansReset: yes · emailChanged: no')).toBeInTheDocument()
  })

  it('skips empty detail values and renders no detail line at all for an empty object', async () => {
    api.get.mockResolvedValue(respond([entry(1, { detail: { a: null, b: '', c: undefined } }), entry(2, { detail: {} })]))
    renderPage()
    await screen.findAllByText('user.update')
    expect(screen.queryByText(/a:|b:|c:/)).toBeNull()
  })

  it('shows "unknown admin" when the actor account no longer exists', async () => {
    api.get.mockResolvedValue(respond([entry(1, { actorEmail: null })]))
    renderPage()
    expect(await screen.findByText(/unknown admin/)).toBeInTheDocument()
  })

  it('shows the empty state when there are no entries', async () => {
    api.get.mockResolvedValue(respond([]))
    renderPage()
    expect(await screen.findByText('No audit entries recorded.')).toBeInTheDocument()
  })

  it('paginates: only shown for >1 page, and Next requests the next page', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(respond(Array.from({ length: 20 }, (_, i) => entry(i)), 45))
    renderPage()
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')
    expect(api.get).toHaveBeenLastCalledWith('/admin/audit-log', { params: { page: 2, pageSize: 20, targetType: undefined } })
  })

  it('a single page of results shows no pagination controls', async () => {
    api.get.mockResolvedValue(respond([entry(1)], 1))
    renderPage()
    await screen.findByText('user.update')
    expect(screen.queryByText(/Page \d+ of/)).toBeNull()
  })

  it('changing the type filter refetches from page 1 with that targetType', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue(respond(Array.from({ length: 20 }, (_, i) => entry(i)), 45))
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Next' }))
    await screen.findByText('Page 2 of 3')

    api.get.mockResolvedValue(respond([entry(9, { action: 'payment.reversed', targetType: 'payment' })], 1))
    await user.selectOptions(screen.getByLabelText('Filter audit log by target type'), 'payment')
    expect(await screen.findByText('payment.reversed')).toBeInTheDocument()
    expect(api.get).toHaveBeenLastCalledWith('/admin/audit-log', { params: { page: 1, pageSize: 20, targetType: 'payment' } })
  })

  it('a load failure shows an error toast instead of crashing', async () => {
    api.get.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the audit log.')
    // ...and the page falls back to its empty state rather than a stuck spinner.
    expect(await screen.findByText('No audit entries recorded.')).toBeInTheDocument()
  })
})
