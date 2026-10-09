// @vitest-environment jsdom
// Section 4 round 7 — admin applications: paging ("Show more"), and the approve modal no longer hides a failed first code
// when the email also failed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminPartners from '../src/pages/admin/AdminPartners'

vi.mock('../src/lib/api', async () => {
  const { getErrorMessage } = await vi.importActual('../src/lib/errors')
  return { default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, getErrorMessage }
})
const toast = vi.fn()
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

const app = (n, over = {}) => ({ id: `a${n}`, name: `Applicant ${n}`, email: `a${n}@x.co`, status: 'PENDING', createdAt: '2026-09-01T00:00:00Z', ...over })
let routes
const mount = () => render(<MemoryRouter><AdminPartners /></MemoryRouter>)
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  routes = {}
  api.get.mockImplementation(url => Promise.resolve(routes[url] || { data: { data: [] } }))
})

describe('Applications panel — paging', () => {
  it('shows the true waiting total, and "Show more" appends the next page without duplicates', async () => {
    const first = Array.from({ length: 50 }, (_, i) => app(i))
    const second = [app(49), ...Array.from({ length: 10 }, (_, i) => app(50 + i))]   // a49 overlaps: a new row shifted the offset
    routes['/partners/applications?status=PENDING&limit=50&offset=0'] = { data: { data: first, total: 60, reapplyCooldownDays: 30 } }
    routes['/partners/applications?status=PENDING&limit=50&offset=50'] = { data: { data: second, total: 60, reapplyCooldownDays: 30 } }
    mount()
    expect(await screen.findByText(/Applications \(60 waiting\)/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /show more \(10 older\)/i }))
    await waitFor(() => expect(screen.getByText('Applicant 59')).toBeTruthy())
    expect(screen.getAllByText('Applicant 49')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })

  it('has no "Show more" when everything fits on the first page', async () => {
    routes['/partners/applications?status=PENDING&limit=50&offset=0'] = { data: { data: [app(1)], total: 1 } }
    mount()
    await screen.findByText('Applicant 1')
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull()
  })
})

describe('Approve application — both the email and the code failed', () => {
  it('warns about the email AND the code that was not created', async () => {
    routes['/partners/applications?status=PENDING&limit=50&offset=0'] = { data: { data: [app(1)], total: 1 } }
    api.post.mockResolvedValue({ data: { success: true, emailed: false, payoutUrl: '', codeError: 'That code is already taken.' } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(toast.mock.calls.length).toBeGreaterThanOrEqual(2))
    const messages = toast.mock.calls.map(c => c[0].message).join(' | ')
    expect(messages).toMatch(/did NOT send/)
    expect(messages).toMatch(/code was not created: That code is already taken\./)
  })
})
