// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import EmployerLeadRejoin from '../../src/pages/EmployerLeadRejoin'

vi.mock('../../src/lib/api', () => ({
  default: { post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const url = '/employer/rejoin?token=abcdefghijk.lmnop'
const renderAt = (u = url) => render(<MemoryRouter initialEntries={[u]}><EmployerLeadRejoin /></MemoryRouter>)
const httpError = (status, message) => Object.assign(new Error('x'), { response: { status, data: { message } } })
async function fill(user, { name = 'Ada', company = 'Acme', field } = {}) {
  await user.type(await screen.findByLabelText('Name'), name)
  await user.type(screen.getByLabelText('Company'), company)
  if (field) await user.selectOptions(screen.getByLabelText('Field (optional)'), field)
}

beforeEach(() => { api.post.mockReset() })

describe('EmployerLeadRejoin', () => {
  it('shows the error state without a token and never posts', async () => {
    renderAt('/employer/rejoin')
    expect(await screen.findByText('Could not add you back')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('does nothing on load and requires name and company', async () => {
    const user = userEvent.setup()
    renderAt()
    expect(api.post).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'Add me back to the list' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Name and company are required.')
    expect(api.post).not.toHaveBeenCalled()
  })
  it('posts token, name, company and field, then shows the joined state', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'joined' } })
    renderAt()
    await fill(user, { field: 'design' })
    await user.click(screen.getByRole('button', { name: 'Add me back to the list' }))
    expect(await screen.findByText("You're back on the list")).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/employer-leads/rejoin', { token: 'abcdefghijk.lmnop', name: 'Ada', company: 'Acme', field: 'design' })
  })
  it('omits field when none chosen and shows the already state', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'already' } })
    renderAt()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Add me back to the list' }))
    expect(await screen.findByText("You're already on the list")).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/employer-leads/rejoin', { token: 'abcdefghijk.lmnop', name: 'Ada', company: 'Acme' })
  })
  it('shows the support message when unavailable', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'unavailable' } })
    renderAt()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Add me back to the list' }))
    expect(await screen.findByText(/Contact support@passthrough.dev/)).toBeInTheDocument()
  })
  it('shows the server message for an invalid link (400) with no retry', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValueOnce(httpError(400, 'This link is not valid.'))
    renderAt()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Add me back to the list' }))
    expect(await screen.findByText('This link is not valid.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
  it('offers a retry after a transient failure and keeps the form values', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValueOnce(httpError(503, 'Server busy.'))
    renderAt()
    await fill(user)
    await user.click(screen.getByRole('button', { name: 'Add me back to the list' }))
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
  })
})
