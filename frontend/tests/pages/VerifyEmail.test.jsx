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
import VerifyEmail from '../../src/pages/VerifyEmail'

const refreshUser = vi.fn()
// Round 6: the token travels in a POST body (not the URL), so verification and resend are both api.post —
// told apart here by URL.
const verifyApi = vi.fn()
const resendApi = vi.fn()
function renderPage(user = null, url = '/verify-email?token=abc') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <AuthContext.Provider value={{ user, refreshUser }}><VerifyEmail /></AuthContext.Provider>
    </MemoryRouter>)
}
const httpErr = (status, message) => Object.assign(new Error('x'), { response: { status, data: { message } } })
beforeEach(() => {
  cleanup(); vi.clearAllMocks()
  verifyApi.mockReset(); resendApi.mockReset()
  api.post.mockImplementation((url, ...rest) => (url === '/auth/verify-email' ? verifyApi(url, ...rest) : resendApi(url, ...rest)))
})

describe('VerifyEmail', () => {
  it('success refreshes the cached user', async () => {
    verifyApi.mockResolvedValue({ data: { success: true } })
    renderPage()
    await screen.findByText('Email verified')
    expect(refreshUser).toHaveBeenCalledTimes(1)
  })
  it('a 400 means the link is dead; signed-out people are pointed at sign-in', async () => {
    verifyApi.mockRejectedValue(httpErr(400, 'Verification link invalid or expired.'))
    renderPage(null)
    await screen.findByText('Verification failed')
    expect(screen.getAllByRole('link', { name: /sign in/i }).some(a => a.getAttribute('href') === '/login?next=%2Fdashboard')).toBe(true)
    expect(screen.queryByRole('button', { name: /new link/i })).toBeNull()
  })
  it('a signed-in person can ask for a new link right there', async () => {
    verifyApi.mockRejectedValue(httpErr(400, 'x'))
    resendApi.mockResolvedValue({ data: { success: true } })
    renderPage({ id: 'u1' })
    await userEvent.setup().click(await screen.findByRole('button', { name: /send me a new link/i }))
    expect(resendApi).toHaveBeenCalledWith('/auth/resend-verification')
    await screen.findByText(/new link sent/i)
  })
  it('a failed resend shows the server message', async () => {
    verifyApi.mockRejectedValue(httpErr(400, 'x'))
    resendApi.mockRejectedValue(httpErr(429, 'Too many attempts.'))
    renderPage({ id: 'u1' })
    await userEvent.setup().click(await screen.findByRole('button', { name: /send me a new link/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/too many attempts/i)
  })
  it('an older link answering 400 while the account is already verified says so, instead of "Verification failed"', async () => {
    verifyApi.mockRejectedValue(httpErr(400, 'Verification link invalid or expired.'))
    refreshUser.mockResolvedValue({ id: 'u1', emailVerified: true })
    renderPage({ id: 'u1' })
    await screen.findByText('Email already verified')
    expect(screen.queryByText('Verification failed')).toBeNull()
    expect(screen.queryByRole('button', { name: /new link/i })).toBeNull()
  })
  it('a 400 for a signed-in account that is NOT verified still offers a new link', async () => {
    verifyApi.mockRejectedValue(httpErr(400, 'x'))
    refreshUser.mockResolvedValue({ id: 'u1', emailVerified: false })
    renderPage({ id: 'u1' })
    await screen.findByText('Verification failed')
    expect(screen.getByRole('button', { name: /send me a new link/i })).toBeInTheDocument()
  })
  it.each([[429, 'Too many attempts.'], [503, 'Down.'], [undefined, undefined]])(
    'status %s is NOT reported as an invalid link — it offers a retry that works', async (status, message) => {
      verifyApi.mockRejectedValueOnce(status ? httpErr(status, message) : new Error('Network Error'))
      verifyApi.mockResolvedValueOnce({ data: { success: true } })
      renderPage()
      expect(await screen.findByText(/couldn't verify just now/i)).toBeInTheDocument()
      expect(screen.queryByText('Verification failed')).toBeNull()
      await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }))
      await screen.findByText('Email verified')
      expect(verifyApi).toHaveBeenCalledTimes(2)
    })
  it('sends the token in the POST body, never in the URL', async () => {
    verifyApi.mockResolvedValue({ data: { success: true } })
    renderPage(null, '/verify-email?token=a%2Bb')
    await screen.findByText('Email verified')
    expect(verifyApi).toHaveBeenCalledWith('/auth/verify-email', { token: 'a+b' })
  })
  it('no token at all is a dead link without calling the API', async () => {
    renderPage(null, '/verify-email')
    await screen.findByText('Verification failed')
    expect(verifyApi).not.toHaveBeenCalled()
  })
})

// Auth round 3 (G3): after a resend the button used to vanish for good — a link that never arrived
// could only be re-requested by reloading. It now stays, counting down.
describe('VerifyEmail — resend timer', () => {
  it('keeps the resend button after a send, disabled with a countdown', async () => {
    verifyApi.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 400, data: { message: 'bad' } } }))
    resendApi.mockResolvedValue({ data: { success: true } })
    const u = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/verify-email?token=dead']}>
        <AuthContext.Provider value={{ user: { id: 'u1' }, refreshUser: vi.fn() }}><VerifyEmail /></AuthContext.Provider>
      </MemoryRouter>)
    await u.click(await screen.findByRole('button', { name: /send me a new link/i }))
    expect(await screen.findByText(/new link sent/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send again in \d+s/i })).toBeDisabled()
  })
})
