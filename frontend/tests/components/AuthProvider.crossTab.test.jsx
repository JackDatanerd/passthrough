// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { AuthProvider } from '../../src/context/AuthContext'
import { useAuth } from '../../src/hooks/useAuth'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  SESSION_ENDED_EVENT: 'passthrough:session-ended',
}))
import api from '../../src/lib/api'

function Probe() {
  const { user, logout } = useAuth()
  return <div><span data-testid="u">{user ? user.email : 'none'}</span><button onClick={() => { window.__p = logout() }}>out</button></div>
}

let replace
function setLocation(pathname, search = '') {
  replace = vi.fn()
  Object.defineProperty(window, 'location', { configurable: true, value: { pathname, search, replace, assign: vi.fn() } })
}
const fire = (key, newValue) => act(() => { window.dispatchEvent(Object.assign(new Event('storage'), { key, newValue })) })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('passthrough_token', 'tok')
  localStorage.setItem('passthrough_user', JSON.stringify({ id: 'u1', email: 'a@b.co' }))
  api.get.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'a@b.co' } } } })
  api.post.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AuthProvider — another tab signs out', () => {
  it('a tab on a protected page is sent to sign-in with its place remembered', async () => {
    setLocation('/dashboard/settings', '?x=1')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    localStorage.removeItem('passthrough_token')
    fire('passthrough_token', null)
    expect(screen.getByTestId('u').textContent).toBe('none')
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fdashboard%2Fsettings%3Fx%3D1')
  })
  it('localStorage.clear() in another tab counts as a sign-out', async () => {
    setLocation('/dashboard')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    localStorage.clear()
    fire(null, null)
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fdashboard')
  })
  it('a public page just drops to signed-out, no redirect', async () => {
    setLocation('/pricing')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    localStorage.removeItem('passthrough_token')
    fire('passthrough_token', null)
    expect(screen.getByTestId('u').textContent).toBe('none')
    expect(replace).not.toHaveBeenCalled()
  })
  it('a sign-out immediately followed by a sign-in elsewhere does not bounce this tab', async () => {
    setLocation('/dashboard')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    localStorage.setItem('passthrough_token', 'tok2')   // the token is back by the time the event is handled
    fire('passthrough_token', null)
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('AuthProvider — logout()', () => {
  it('returns a promise that settles after the revoke request, and never rejects', async () => {
    setLocation('/')
    api.post.mockRejectedValueOnce(new Error('offline'))
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    await act(async () => { screen.getByText('out').click() })
    await expect(window.__p).resolves.toBeUndefined()
    expect(api.post).toHaveBeenCalledWith('/auth/logout', null, { headers: { Authorization: 'Bearer tok' } })
  })
  it('with no token it still returns a resolved promise', async () => {
    setLocation('/')
    localStorage.removeItem('passthrough_token')
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { screen.getByText('out').click() })
    await expect(window.__p).resolves.toBeUndefined()
    expect(api.post).not.toHaveBeenCalled()
  })
})
