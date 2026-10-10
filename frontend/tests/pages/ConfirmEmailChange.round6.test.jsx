// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../../src/context/AuthContext'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fb) => err?.response?.data?.message || fb,
}))
import api from '../../src/lib/api'
import ConfirmEmailChange from '../../src/pages/ConfirmEmailChange'

const adoptSession = vi.fn()
const httpErr = (status, message) => Object.assign(new Error('x'), { response: { status, data: { message } } })
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/confirm-email-change?token=tok']}>
      <AuthContext.Provider value={{ adoptSession, logout: vi.fn() }}><ConfirmEmailChange /></AuthContext.Provider>
    </MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('ConfirmEmailChange — round 6 retry', () => {
  it.each([[429, 'Slow down.'], [503, 'Try later.'], [undefined, undefined]])(
    'status %s is not reported as a dead link; Try again re-submits the same token', async (status, message) => {
      api.post.mockRejectedValueOnce(status ? httpErr(status, message) : new Error('Network Error'))
      api.post.mockResolvedValueOnce({ data: { data: { user: { id: 'u' }, token: 'new' } } })
      renderPage()
      expect(await screen.findByText(/couldn't confirm just now/i)).toBeInTheDocument()
      expect(screen.queryByText('Confirmation failed')).toBeNull()
      await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }))
      await screen.findByText('Email updated')
      expect(api.post).toHaveBeenCalledTimes(2)
      expect(api.post).toHaveBeenLastCalledWith('/auth/email/confirm', { token: 'tok' })
      expect(adoptSession).toHaveBeenCalledWith('new', { id: 'u' })
    })
  it('a 400 is still a dead link', async () => {
    api.post.mockRejectedValue(httpErr(400, 'Confirmation link invalid or expired.'))
    renderPage()
    await screen.findByText('Confirmation failed')
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })
})
