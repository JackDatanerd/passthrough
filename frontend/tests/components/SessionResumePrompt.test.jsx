// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const auth = { user: { id: 'u1', email: 'jane@example.com' }, adoptSession: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { post: vi.fn() },
  setSessionResumePrompt: vi.fn(),
  getErrorMessage: (err, fb) => err?.response?.data?.message || fb,
}))
import api, { setSessionResumePrompt } from '../../src/lib/api'
import SessionResumePrompt from '../../src/components/layout/SessionResumePrompt'

function mountAndAsk() {
  render(<SessionResumePrompt />)
  const ask = setSessionResumePrompt.mock.calls.at(-1)[0]
  let promise
  act(() => { promise = ask() })
  return promise
}
beforeEach(() => { api.post.mockReset(); auth.adoptSession.mockReset(); setSessionResumePrompt.mockClear(); auth.user = { id: 'u1', email: 'jane@example.com' } })

describe('SessionResumePrompt', () => {
  it('registers with the API client on mount and unregisters on unmount', () => {
    const { unmount } = render(<SessionResumePrompt />)
    expect(typeof setSessionResumePrompt.mock.calls[0][0]).toBe('function')
    unmount()
    expect(setSessionResumePrompt).toHaveBeenLastCalledWith(null)
  })

  it('signs the same account back in, adopts the session and resolves true', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { token: 'new.tok.en', user: { id: 'u1', email: 'jane@example.com' } } } })
    const p = mountAndAsk()
    expect(await screen.findByRole('dialog', { name: 'Your session ended' })).toBeInTheDocument()
    expect(screen.getByText('jane@example.com')).toBeInTheDocument()
    await user.type(screen.getByLabelText('Password'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    await expect(p).resolves.toBe(true)
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'jane@example.com', password: 'hunter2' })
    expect(auth.adoptSession).toHaveBeenCalledWith('new.tok.en', { id: 'u1', email: 'jane@example.com' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a wrong password shows the server message and stays open', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValue({ response: { status: 401, data: { message: 'Invalid credentials' } } })
    mountAndAsk()
    await user.type(await screen.findByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials')
    expect(auth.adoptSession).not.toHaveBeenCalled()
  })

  it('a login that is a DIFFERENT account is refused and not adopted', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { token: 't', user: { id: 'someone-else' } } } })
    mountAndAsk()
    await user.type(await screen.findByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: 'Sign in and continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/different account/)
    expect(auth.adoptSession).not.toHaveBeenCalled()
  })

  it('"Discard my changes" resolves false', async () => {
    const user = userEvent.setup()
    const p = mountAndAsk()
    await user.click(await screen.findByRole('button', { name: 'Discard my changes' }))
    await expect(p).resolves.toBe(false)
  })

  it('with nobody to sign back in as, it resolves false without opening', async () => {
    auth.user = null
    render(<SessionResumePrompt />)
    const ask = setSessionResumePrompt.mock.calls.at(-1)[0]
    await expect(ask()).resolves.toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
