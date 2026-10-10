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
// The confirm page needs a click now (mail scanners that run JS used to confirm addresses on load).
async function renderConfirmAndClick(user, url) {
  renderAt('confirm', url)
  await user.click(await screen.findByRole('button', { name: 'Yes, confirm my email' }))
}
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

// Independent audit round 9 (Section 5): a confirmed lead with no field on file is asked for it.
describe('EmployerLeadAction — asking for the field after confirming', () => {
  const url = '/employer/confirm?token=abcdefghijk.lmnop'

  it('shows the picker when the server says no field is on file, and saves the choice with the same token', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'confirmed', needsField: true } })
      .mockResolvedValueOnce({ data: { success: true, status: 'saved' } })
    await renderConfirmAndClick(user, url)
    expect(await screen.findByText('Email confirmed')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Which field are you hiring in?'), 'design')
    await user.click(save)
    expect(await screen.findByText(/Saved — we'll email you/)).toBeInTheDocument()
    expect(api.post).toHaveBeenLastCalledWith('/employer-leads/field', { token: 'abcdefghijk.lmnop', field: 'design' })
  })
  it('does not ask when a field is already on file', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'confirmed', needsField: false } })
    await renderConfirmAndClick(user, url)
    expect(await screen.findByText('Email confirmed')).toBeInTheDocument()
    expect(screen.queryByLabelText('Which field are you hiring in?')).toBeNull()
  })
  it('asks for an already-confirmed address that still has no field', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'already', needsField: true } })
    await renderConfirmAndClick(user, url)
    expect(await screen.findByText('Already confirmed')).toBeInTheDocument()
    expect(screen.getByLabelText('Which field are you hiring in?')).toBeInTheDocument()
  })
  it('shows the error and keeps the picker when saving fails', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'confirmed', needsField: true } })
      .mockRejectedValueOnce(httpError(503, 'Server busy.'))
    await renderConfirmAndClick(user, url)
    await screen.findByText('Email confirmed')
    await user.selectOptions(screen.getByLabelText('Which field are you hiring in?'), 'sales')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Server busy.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
  it('the remove page never shows a picker', async () => {
    renderAt('remove', '/employer/remove?token=abcdefghijk.lmnop')
    expect(await screen.findByRole('button', { name: 'Yes, remove me' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Which field are you hiring in?')).toBeNull()
  })
})

describe('EmployerLeadAction — confirm needs a click', () => {
  const url = '/employer/confirm?token=abcdefghijk.lmnop'
  it('does not POST on load, only after the button is pressed', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'confirmed' } })
    renderAt('confirm', url)
    expect(await screen.findByText('Confirm your email?')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Yes, confirm my email' }))
    expect(await screen.findByText('Email confirmed')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/employer-leads/confirm', { token: 'abcdefghijk.lmnop' })
  })
  it('a confirm link without a token shows the error state', async () => {
    renderAt('confirm', '/employer/confirm')
    expect(await screen.findByText('Confirmation failed')).toBeInTheDocument()
  })
  it("shows a neutral message when the field was already on file", async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValueOnce({ data: { success: true, status: 'confirmed', needsField: true } })
      .mockResolvedValueOnce({ data: { success: true, status: 'already' } })
    await renderConfirmAndClick(user, url)
    await screen.findByText('Email confirmed')
    await user.selectOptions(screen.getByLabelText('Which field are you hiring in?'), 'sales')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Your field is already on file.')).toBeInTheDocument()
    expect(screen.queryByText(/Saved — we'll email you/)).toBeNull()
  })
})
