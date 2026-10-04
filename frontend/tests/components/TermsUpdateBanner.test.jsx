// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { AuthContext } from '../../src/context/AuthContext'
import TermsUpdateBanner from '../../src/components/layout/TermsUpdateBanner'

function renderBanner(authValue) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <TermsUpdateBanner />
      </AuthContext.Provider>
    </MemoryRouter>
  )
}

describe('TermsUpdateBanner', () => {
  it('shows nothing when signed out, current, or when the flag is simply absent (older cached user)', () => {
    for (const user of [null, { termsCurrent: true }, { role: 'USER' }]) {
      const { unmount } = renderBanner({ user, acceptTerms: vi.fn() })
      expect(screen.queryByRole('button', { name: /i agree/i })).toBeNull()
      unmount()
    }
  })
  it('asks for acceptance only when the server says the accepted version is stale', async () => {
    const acceptTerms = vi.fn().mockResolvedValue({})
    renderBanner({ user: { termsCurrent: false }, acceptTerms })
    await userEvent.setup().click(screen.getByRole('button', { name: /i agree/i }))
    expect(acceptTerms).toHaveBeenCalledTimes(1)
  })
  it('shows the failure and lets the person retry', async () => {
    const acceptTerms = vi.fn().mockRejectedValue(new Error('boom'))
    renderBanner({ user: { termsCurrent: false }, acceptTerms })
    await userEvent.setup().click(screen.getByRole('button', { name: /i agree/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /i agree/i })).not.toBeDisabled()
  })
})
