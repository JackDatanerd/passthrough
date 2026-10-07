// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react'
import { AuthProvider } from '../../src/context/AuthContext'
import { useAuth } from '../../src/hooks/useAuth'
import { addAnonScanToken, getAnonScanTokens } from '../../src/lib/anonScans'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  SESSION_ENDED_EVENT: 'passthrough:session-ended',
}))
import api from '../../src/lib/api'

function Probe() {
  const { user, logout } = useAuth()
  return <div><span data-testid="u">{user ? user.email : 'none'}</span><button onClick={() => { logout() }}>out</button></div>
}

const DRAFT = 'passthrough_brain_dump_draft'

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('passthrough_token', 'tok')
  localStorage.setItem('passthrough_user', JSON.stringify({ id: 'u1', email: 'a@b.co' }))
  localStorage.setItem(DRAFT, JSON.stringify({ text: 'my background', name: 'Ada', email: 'ada@x.co' }))
  addAnonScanToken('scan-1', 'anon-secret')
  api.get.mockResolvedValue({ data: { data: { user: { id: 'u1', email: 'a@b.co' } } } })
  api.post.mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AuthProvider.logout — browser-held personal data goes with the session', () => {
  it('clears the brain-dump draft and unclaimed anonymous-scan tokens, as well as the token and user', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    expect(getAnonScanTokens()).toHaveLength(1)
    await act(async () => { fireEvent.click(screen.getByText('out')) })
    expect(localStorage.getItem('passthrough_token')).toBeNull()
    expect(localStorage.getItem('passthrough_user')).toBeNull()
    expect(localStorage.getItem(DRAFT)).toBeNull()
    expect(getAnonScanTokens()).toHaveLength(0)
    expect(screen.getByTestId('u').textContent).toBe('none')
  })
  it('still clears them when there was no token to revoke', async () => {
    localStorage.removeItem('passthrough_token')
    render(<AuthProvider><Probe /></AuthProvider>)
    await act(async () => { fireEvent.click(screen.getByText('out')) })
    expect(localStorage.getItem(DRAFT)).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })
  it('an expired/ended session (not a sign-out) leaves the draft alone', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('a@b.co')
    act(() => { window.dispatchEvent(new CustomEvent('passthrough:session-ended', { detail: { reason: 'expired' } })) })
    expect(localStorage.getItem(DRAFT)).not.toBeNull()
  })
})
