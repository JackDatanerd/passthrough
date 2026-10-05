// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import EmployerLeadAction from '../../src/pages/EmployerLeadAction'

vi.mock('../../src/lib/api', () => ({
  default: { post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const renderAt = (mode, url) => render(<MemoryRouter initialEntries={[url]}><EmployerLeadAction mode={mode} /></MemoryRouter>)
const httpError = (status, message) => Object.assign(new Error('x'), { response: { status, data: { message } } })

beforeEach(() => { api.post.mockReset() })

describe('EmployerLeadAction — failed removal (B6)', () => {
  it('offers Try again after a transient failure, and a retry that works shows the success state', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValueOnce(httpError(503, 'Server busy.')).mockResolvedValueOnce({ data: { success: true } })
    renderAt('remove', '/employer/remove?token=abcdefghijk.lmnop')
    await user.click(await screen.findByRole('button', { name: 'Yes, remove me' }))
    expect(await screen.findByText('Removal failed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText("You've been removed")).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledTimes(2)
  })
  it('does not offer a retry for a link the server rejected (400) — it can never work', async () => {
    const user = userEvent.setup()
    api.post.mockImplementation(() => Promise.reject(httpError(400, 'This link is not valid.')))
    renderAt('remove', '/employer/remove?token=abcdefghijk.lmnop')
    await user.click(await screen.findByRole('button', { name: 'Yes, remove me' }))
    expect(await screen.findByText('Removal failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
  it('a link with no token has nothing to retry', async () => {
    renderAt('remove', '/employer/remove')
    expect(await screen.findByText('Removal failed')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })
})
