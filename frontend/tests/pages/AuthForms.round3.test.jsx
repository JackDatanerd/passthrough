// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthContext, AuthProvider } from '../../src/context/AuthContext'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fb) => err?.response?.data?.message || fb,
  SESSION_ENDED_EVENT: 'passthrough:session-ended',
}))
// Turnstile switched ON for these tests: a button that "solves" the challenge.
vi.mock('../../src/components/lead/TurnstileWidget', async () => {
  const React = await import('react')
  return {
    TURNSTILE_ENABLED: true,
    default: ({ onToken }) => React.createElement('button', { type: 'button', onClick: () => onToken('captcha-tok') }, 'solve-challenge'),
  }
})
import api from '../../src/lib/api'
import Login from '../../src/pages/Login'
import Register from '../../src/pages/Register'
import ForgotPassword from '../../src/pages/ForgotPassword'
import ConfirmEmailChange from '../../src/pages/ConfirmEmailChange'

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}</div> }
function renderAt(path, element, route, ctx = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ user: null, authLoading: false, postAuthActions: vi.fn(), postRegisterActions: vi.fn(), logout: vi.fn(), ...ctx }}>
        <Routes>
          <Route path={route} element={element} />
          <Route path="*" element={<Where />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear() })
afterEach(() => vi.restoreAllMocks())

describe('Login (B3, G3)', () => {
  const signIn = async (u) => {
    await u.type(screen.getByLabelText('Email'), 'a@b.co')
    await u.type(screen.getByLabelText('Password'), 'correct-horse-9')
    await u.click(screen.getByRole('button', { name: 'Sign in' }))
  }
  it('a scan claimed during sign-in wins over ?next= (same as Register)', async () => {
    const u = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { token: 't', user: { id: 'u1' } } } })
    const postAuthActions = vi.fn().mockResolvedValue('scan-9')
    renderAt('/login?next=%2Fdashboard%2Fsettings', <Login />, '/login', { postAuthActions })
    await signIn(u)
    expect((await screen.findByTestId('where')).textContent).toBe('/scan/scan-9')
  })
  it('with nothing claimed, ?next= is honored', async () => {
    const u = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { token: 't', user: { id: 'u1' } } } })
    renderAt('/login?next=%2Fdashboard%2Fsettings', <Login />, '/login', { postAuthActions: vi.fn().mockResolvedValue(null) })
    await signIn(u)
    expect((await screen.findByTestId('where')).textContent).toBe('/dashboard/settings')
  })
  it('"Forgot password?" carries the typed email, and is plain when nothing was typed', async () => {
    const u = userEvent.setup()
    renderAt('/login', <Login />, '/login')
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute('href', '/forgot-password')
    await u.type(screen.getByLabelText('Email'), 'a+b@c.co')
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute('href', '/forgot-password?email=a%2Bb%40c.co')
  })
  it('the password field has a Show/Hide toggle', async () => {
    const u = userEvent.setup()
    renderAt('/login', <Login />, '/login')
    await u.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
  })
})

describe('Register — Turnstile (G1) and password toggles (G2)', () => {
  async function fillIn(u) {
    await u.type(screen.getByLabelText('Name'), 'Ada')
    await u.type(screen.getByLabelText('Email'), 'ada@example.com')
    await u.type(screen.getByLabelText('Password'), 'correct-horse-battery-9')
    await u.type(screen.getByLabelText('Confirm password'), 'correct-horse-battery-9')
    await u.click(screen.getByRole('checkbox'))
  }
  it('will not submit before the challenge is solved', async () => {
    const u = userEvent.setup()
    renderAt('/register', <Register />, '/register')
    await fillIn(u)
    await u.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/security check/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('sends the challenge token with the sign-up', async () => {
    const u = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { token: 't', user: { id: 'u1' } } } })
    renderAt('/register', <Register />, '/register', { postRegisterActions: vi.fn().mockResolvedValue(null) })
    await fillIn(u)
    await u.click(screen.getByRole('button', { name: 'solve-challenge' }))
    await u.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][0]).toBe('/auth/register')
    expect(api.post.mock.calls[0][1]).toMatchObject({ email: 'ada@example.com', acceptTerms: true, turnstileToken: 'captcha-tok' })
  })
  it('both password fields have their own Show/Hide toggle', () => {
    renderAt('/register', <Register />, '/register')
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(2)
  })
})

describe('ForgotPassword — prefill, Turnstile, resend timer (G1, G3)', () => {
  it('is prefilled from ?email=', () => {
    renderAt('/forgot-password?email=ada%40example.com', <ForgotPassword />, '/forgot-password')
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
  })
  it('will not send before the challenge is solved', async () => {
    const u = userEvent.setup()
    renderAt('/forgot-password?email=ada%40example.com', <ForgotPassword />, '/forgot-password')
    await u.click(screen.getByRole('button', { name: /send reset link/i }))
    expect(await screen.findByText(/security check/i)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('sends the token, then shows a disabled "Send again in Ns" timer', async () => {
    const u = userEvent.setup()
    api.post.mockResolvedValue({ data: { success: true } })
    renderAt('/forgot-password?email=ada%40example.com', <ForgotPassword />, '/forgot-password')
    await u.click(screen.getByRole('button', { name: 'solve-challenge' }))
    await u.click(screen.getByRole('button', { name: /send reset link/i }))
    await screen.findByText(/check your inbox/i)
    expect(api.post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'ada@example.com', turnstileToken: 'captcha-tok' })
    expect(screen.getByRole('button', { name: /send again in \d+s/i })).toBeDisabled()
  })
})

describe('ConfirmEmailChange (B4)', () => {
  it('adopts the fresh session even when the cached user is missing — the old token is already dead', async () => {
    localStorage.setItem('passthrough_token', 'old-dead-token')       // token present, cached user absent
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'new@x.co' }, token: 'fresh-token' } } })
    const adoptSession = vi.fn(), postAuthActions = vi.fn().mockResolvedValue(null)
    renderAt('/confirm-email-change?token=abc', <ConfirmEmailChange />, '/confirm-email-change', { adoptSession, postAuthActions })
    expect(await screen.findByText('Email updated')).toBeInTheDocument()
    expect(adoptSession).toHaveBeenCalledWith('fresh-token', { id: 'u1', email: 'new@x.co' })
    expect(screen.queryByText(/different account/i)).toBeNull()
  })
  // Auth round 4 (B4): confirming an address swaps the identity of a browser that is already signed in;
  // postAuthActions would also claim every stored anonymous scan into the account.
  it('never claims anonymous scans (that belongs to signing in / registering)', async () => {
    api.post.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'new@x.co' }, token: 'fresh-token' } } })
    const adoptSession = vi.fn(), postAuthActions = vi.fn().mockResolvedValue(null)
    renderAt('/confirm-email-change?token=abc', <ConfirmEmailChange />, '/confirm-email-change', { adoptSession, postAuthActions })
    await screen.findByText('Email updated')
    expect(postAuthActions).not.toHaveBeenCalled()
    expect(api.post).toHaveBeenCalledTimes(1)       // only the confirmation itself — no /auth/claim-scan
  })
  it('a replayed link adopts nothing', async () => {
    api.post.mockResolvedValue({ data: { data: { alreadyConfirmed: true } } })
    const postAuthActions = vi.fn(), adoptSession = vi.fn()
    renderAt('/confirm-email-change?token=abc', <ConfirmEmailChange />, '/confirm-email-change', { postAuthActions, adoptSession })
    expect(await screen.findByText('Already confirmed')).toBeInTheDocument()
    expect(postAuthActions).not.toHaveBeenCalled()
    expect(adoptSession).not.toHaveBeenCalled()
  })
})

describe('AuthProvider with browser storage blocked (B5)', () => {
  it('renders instead of crashing, and a sign-in still works for this visit', async () => {
    const boom = () => { throw new DOMException('blocked', 'SecurityError') }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom)
    let ctx
    function Grab() { ctx = React_useAuth(); return <span data-testid="u">{ctx.user ? ctx.user.id : 'none'}</span> }
    const { useAuth: React_useAuth } = await import('../../src/hooks/useAuth')
    render(<AuthProvider><Grab /></AuthProvider>)
    expect(screen.getByTestId('u').textContent).toBe('none')
    await ctx.postAuthActions('tok', { id: 'u7' })
    await waitFor(() => expect(screen.getByTestId('u').textContent).toBe('u7'))
  })
})
