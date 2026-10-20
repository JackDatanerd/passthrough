// @vitest-environment jsdom
// Round 21 (G3): the resume form carries the account email as a username field so a password manager can fill the password.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'

const auth = { user: { id: 'u1', email: 'jane@example.com' }, adoptSession: vi.fn() }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({ default: { post: vi.fn() }, setSessionResumePrompt: vi.fn(), getErrorMessage: (e, fb) => fb }))
import { setSessionResumePrompt } from '../../src/lib/api'
import SessionResumePrompt from '../../src/components/layout/SessionResumePrompt'

describe('SessionResumePrompt username field', () => {
  it('has a read-only email input named username, out of the Tab order and hidden from assistive tech, beside the password field', async () => {
    render(<SessionResumePrompt />)
    act(() => { setSessionResumePrompt.mock.calls.at(-1)[0]() })
    const dialog = await screen.findByRole('dialog', { name: 'Your session ended' })
    const user = dialog.querySelector('input[autocomplete="username"]')
    expect(user).not.toBeNull()
    expect(user.value).toBe('jane@example.com')
    expect(user).toHaveAttribute('readonly')
    expect(user).toHaveAttribute('tabindex', '-1')
    expect(user).toHaveAttribute('aria-hidden', 'true')
    expect(user.closest('form')).toBe(screen.getByLabelText('Password').closest('form'))
  })
})
