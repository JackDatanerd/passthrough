// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AuthContext, AuthProvider } from '../../src/context/AuthContext'
import { useAuth } from '../../src/hooks/useAuth'
import { addAnonScanToken, getAnonScanTokens } from '../../src/lib/anonScans'
import Login from '../../src/pages/Login'
import Register from '../../src/pages/Register'

// Auth round 4 — B2 (a cached user without a token), B4 (adoptSession claims nothing).

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fb) => err?.response?.data?.message || fb,
  SESSION_ENDED_EVENT: 'passthrough:session-ended',
}))
vi.mock('../../src/components/lead/TurnstileWidget', () => ({ TURNSTILE_ENABLED: false, default: () => null }))
import api from '../../src/lib/api'

const TOKEN = 'passthrough_token', USER = 'passthrough_user'

function Probe() {
  const { user, acceptTerms, adoptSession, postAuthActions } = useAuth()
  return (
    <div>
      <span data-testid="u">{user ? user.email : 'none'}</span>
      <button onClick={() => { acceptTerms().catch(() => {}) }}>accept</button>
      <button onClick={() => adoptSession('adopted-token', { id: 'u1', email: 'adopted@x.co' })}>adopt</button>
      <button onClick={() => { postAuthActions('signin-token', { id: 'u1', email: 'signin@x.co' }) }}>signin</button>
    </div>
  )
}

beforeEach(() => { localStorage.clear(); api.get.mockReset(); api.post.mockReset(); api.get.mockResolvedValue({ data: { data: {} } }) })   // Register reads the free-scan limit via usePricing
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AuthProvider — a cached user is only real alongside its token (B2)', () => {
  it('drops a stranded cached user on load when there is no token', () => {
    localStorage.setItem(USER, JSON.stringify({ id: 'u1', email: 'ghost@x.co' }))
    render(<AuthProvider><Probe /></AuthProvider>)
    expect(screen.getByTestId('u').textContent).toBe('none')
    expect(localStorage.getItem(USER)).toBeNull()
  })
  it('keeps the cached user when the token is there', async () => {
    localStorage.setItem(TOKEN, 'tok')
    localStorage.setItem(USER, JSON.stringify({ id: 'u1', email: 'real@x.co' }))
    api.get.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'real@x.co' } } } })
    render(<AuthProvider><Probe /></AuthProvider>)
    expect(await screen.findByText('real@x.co')).toBeInTheDocument()
  })
  it('acceptTerms landing after a sign-out does not write the user back', async () => {
    localStorage.setItem(TOKEN, 'tok')
    localStorage.setItem(USER, JSON.stringify({ id: 'u1', email: 'a@x.co' }))
    api.get.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'a@x.co' } } } })
    let release
    api.post.mockImplementation(() => new Promise(r => { release = () => r({ data: { data: { user: { id: 'u1', email: 'a@x.co', termsCurrent: true } } } }) }))
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@x.co')
    fireEvent.click(screen.getByText('accept'))
    localStorage.removeItem(TOKEN); localStorage.removeItem(USER)      // signed out in another tab meanwhile
    await act(async () => { release() })
    expect(localStorage.getItem(USER)).toBeNull()
  })
  it('acceptTerms still updates the user when only the token was renewed (same session)', async () => {
    const mk = sid => `h.${btoa(JSON.stringify({ sid })).replace(/=+$/, '')}.s`
    const t1 = mk('11111111-1111-1111-1111-111111111111'), t2 = t1 + 'x'
    localStorage.setItem(TOKEN, t1)
    localStorage.setItem(USER, JSON.stringify({ id: 'u1', email: 'a@x.co', termsCurrent: false }))
    api.get.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'a@x.co', termsCurrent: false } } } })
    let release
    api.post.mockImplementation(() => new Promise(r => { release = () => r({ data: { data: { user: { id: 'u1', email: 'a@x.co', termsCurrent: true } } } }) }))
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@x.co')
    fireEvent.click(screen.getByText('accept'))
    localStorage.setItem(TOKEN, t2)                                    // renewed token, same sid
    await act(async () => { release() })
    expect(JSON.parse(localStorage.getItem(USER)).termsCurrent).toBe(true)
  })
  it.each([['Login', <Login />, '/login'], ['Register', <Register />, '/register']])(
    '%s shows its form (no redirect loop) when a user is held but no token is',
    (_n, page, path) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <AuthContext.Provider value={{ user: { id: 'u1', email: 'ghost@x.co' }, authLoading: false, postAuthActions: vi.fn(), postRegisterActions: vi.fn() }}>
            <Routes><Route path={path} element={page} /><Route path="*" element={<div>elsewhere</div>} /></Routes>
          </AuthContext.Provider>
        </MemoryRouter>)
      expect(screen.queryByText('elsewhere')).toBeNull()
      expect(screen.getByRole('button', { name: /sign in|create account/i })).toBeInTheDocument()
    })
  it.each([['Login', <Login />, '/login'], ['Register', <Register />, '/register']])(
    '%s still sends a genuinely signed-in visitor to the dashboard',
    (_n, page, path) => {
      localStorage.setItem(TOKEN, 'tok')
      render(
        <MemoryRouter initialEntries={[path]}>
          <AuthContext.Provider value={{ user: { id: 'u1', email: 'a@x.co' }, authLoading: false, postAuthActions: vi.fn(), postRegisterActions: vi.fn() }}>
            <Routes><Route path={path} element={page} /><Route path="/dashboard" element={<div>dash</div>} /></Routes>
          </AuthContext.Provider>
        </MemoryRouter>)
      expect(screen.getByText('dash')).toBeInTheDocument()
    })
})

describe('AuthProvider.adoptSession vs postAuthActions (B4)', () => {
  it('adoptSession stores the session and claims NO anonymous scans', async () => {
    addAnonScanToken('scan-1', 'anon-secret')
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { fireEvent.click(screen.getByText('adopt')) })
    expect(localStorage.getItem(TOKEN)).toBe('adopted-token')
    expect(JSON.parse(localStorage.getItem(USER)).email).toBe('adopted@x.co')
    expect(screen.getByTestId('u').textContent).toBe('adopted@x.co')
    expect(api.post).not.toHaveBeenCalled()
    expect(getAnonScanTokens()).toHaveLength(1)
  })
  it('postAuthActions (sign-in / register) still claims them', async () => {
    addAnonScanToken('scan-1', 'anon-secret')
    api.post.mockResolvedValue({ data: { data: { scanId: 'scan-1' } } })
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { fireEvent.click(screen.getByText('signin')) })
    expect(api.post).toHaveBeenCalledWith('/auth/claim-scan', { anonToken: 'anon-secret' })
    expect(getAnonScanTokens()).toHaveLength(0)
  })
})
