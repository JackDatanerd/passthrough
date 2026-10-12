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
import ResetPassword from '../../src/pages/ResetPassword'

const refreshUser = vi.fn()
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reset-password?token=tok']}>
      <AuthContext.Provider value={{ user: null, refreshUser }}><ResetPassword /></AuthContext.Provider>
    </MemoryRouter>)
}
async function submit() {
  const u = userEvent.setup()
  await screen.findByText('Set new password')
  await u.type(screen.getByLabelText('New password'), 'correct-horse-battery-9')
  await u.type(screen.getByLabelText('Confirm password'), 'correct-horse-battery-9')
  await u.click(screen.getByRole('button', { name: /reset password/i }))
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); localStorage.clear()
  api.post.mockImplementation(async url => (url === '/auth/reset-password/validate'
    ? { data: { data: { valid: true } } }
    : { data: { success: true } }))
})

describe('ResetPassword — a session this browser still holds', () => {
  it('is re-checked after a successful reset (the reset revoked it), so Login does not bounce into "session expired"', async () => {
    localStorage.setItem('passthrough_token', 'old')
    renderPage(); await submit()
    await screen.findByText(/password reset/i)
    expect(refreshUser).toHaveBeenCalledTimes(1)
  })
  it('nothing to re-check when the browser holds no session', async () => {
    renderPage(); await submit()
    await screen.findByText(/password reset/i)
    expect(refreshUser).not.toHaveBeenCalled()
  })
  it('a failed reset does not touch the session', async () => {
    localStorage.setItem('passthrough_token', 'old')
    api.post.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 400, data: { message: 'Bad link' } } }))
    renderPage(); await submit()
    await screen.findByText('Bad link')
    expect(refreshUser).not.toHaveBeenCalled()
  })
})

describe('ResetPassword — a link that dies after the page loaded (Auth round 9, B3)', () => {
  it('swaps the form for "request a new one" when the server says the link is dead', async () => {
    api.post.mockImplementation(async url => {
      if (url === '/auth/reset-password/validate') return { data: { data: { valid: true } } }
      throw Object.assign(new Error('x'), { response: { status: 400, data: { code: 'RESET_LINK_INVALID', message: 'Reset link invalid or expired.' } } })
    })
    renderPage(); await submit()
    expect(await screen.findByText(/invalid, has already been used, or has expired/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /request a new one/i })).toBeInTheDocument()
  })
  it('keeps the form for any other 400 (a rejected password, say)', async () => {
    api.post.mockImplementation(async url => {
      if (url === '/auth/reset-password/validate') return { data: { data: { valid: true } } }
      throw Object.assign(new Error('x'), { response: { status: 400, data: { message: 'That password is too common.' } } })
    })
    renderPage(); await submit()
    expect(await screen.findByText('That password is too common.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /request a new one/i })).toBeNull()
  })
})
