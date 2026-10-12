// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import EmployerLeadPreferences from '../../src/pages/EmployerLeadPreferences'

vi.mock('../../src/lib/api', () => ({
  default: { post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const TOKEN = 'abcdefghijk.lmnop'
const renderAt = (u = `/employer/preferences?token=${TOKEN}`) => render(<MemoryRouter initialEntries={[u]}><EmployerLeadPreferences /></MemoryRouter>)
beforeEach(() => { api.post.mockReset() })

describe('EmployerLeadPreferences', () => {
  it('shows the error state without a token and never posts', async () => {
    renderAt('/employer/preferences')
    expect(await screen.findByText('Could not open this link')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('loads the current details, saves the edits and shows the saved state', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'ok', data: { field: 'sales', extraFields: ['design'], roleTitle: 'Recruiter' } } })
    renderAt()
    expect(await screen.findByLabelText('Main field')).toHaveValue('sales')
    expect(screen.getByLabelText('Job title (optional)')).toHaveValue('Recruiter')
    expect(api.post).toHaveBeenCalledWith('/employer-leads/preferences/load', { token: TOKEN })
    await user.selectOptions(screen.getByLabelText('Main field'), 'marketing')
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'saved' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(api.post).toHaveBeenLastCalledWith('/employer-leads/preferences', { token: TOKEN, field: 'marketing', extraFields: ['design'], roleTitle: 'Recruiter' })
  })
  it('says so when the lead no longer exists', async () => {
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'not_found' } })
    renderAt()
    expect(await screen.findByText('Nothing to update')).toBeInTheDocument()
  })
  it('shows the server message for an invalid link', async () => {
    api.post.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 400, data: { message: 'This link is not valid.' } } }))
    renderAt()
    expect(await screen.findByText('This link is not valid.')).toBeInTheDocument()
  })
})
