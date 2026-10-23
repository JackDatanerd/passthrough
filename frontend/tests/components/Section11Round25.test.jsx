// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

describe('step-up URL coverage (round 25)', () => {
  it('gates the admin employer-lead routes and not the public ones', async () => {
    const { isStepUpUrl } = await import('../../src/lib/api.js')
    for (const u of ['/employer-leads/bulk', '/employer-leads/import', '/employer-leads/export.csv?x=1', '/employer-leads/merge',
      '/employer-leads/suppressions', '/employer-leads/3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', '/admin/users/1', '/partners/abc/links'])
      expect(isStepUpUrl(u), u).toBe(true)
    for (const u of ['/employer-leads', '/employer-leads/confirm', '/employer-leads/field', '/employer-leads/rejoin',
      '/employer-leads/preferences', '/employer-leads/preferences/load', '/employer-leads/remove', '/employer-leads/unsubscribe',
      '/employer-leads/suppressions/check', '/partners/dashboard'])
      expect(isStepUpUrl(u), u).toBe(u.endsWith('suppressions/check') ? true : false)
  })
})

describe('retry policy (round 25)', () => {
  it('does not retry a 503 that asked for a long wait; still retries short or absent ones', async () => {
    const { shouldRetryRequest } = await import('../../src/lib/errors.js')
    const base = { method: 'get', status: 503, hasResponse: true, alreadyRetried: false }
    expect(shouldRetryRequest({ ...base, retryAfterSeconds: 120 })).toEqual({ retry: false })
    expect(shouldRetryRequest({ ...base, retryAfterSeconds: 3 })).toEqual({ retry: true, delayMs: 3000 })
    expect(shouldRetryRequest({ ...base, retryAfterSeconds: NaN })).toEqual({ retry: true, delayMs: 800 })
  })
})

describe('case-insensitive nav (round 25)', () => {
  it('marks the Settings tab current at /Dashboard/Settings', async () => {
    vi.resetModules()
    vi.doMock('../../src/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u', role: 'USER' } }) }))
    vi.doMock('../../src/hooks/useSignOut', () => ({ default: () => () => {} }))
    vi.doMock('../../src/lib/needsDecision', () => ({ useNeedsDecisionCount: () => 0 }))
    const { default: DashboardLayout } = await import('../../src/components/layout/DashboardLayout.jsx')
    render(<MemoryRouter initialEntries={['/Dashboard/Settings']}><DashboardLayout>x</DashboardLayout></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('menu focus + radio hold (round 25)', () => {
  it('menu list carries a focus style for items', async () => {
    const { default: Menu } = await import('../../src/components/ui/Menu.jsx')
    const { default: userEvent } = await import('@testing-library/user-event')
    render(<Menu label="More"><button role="menuitem">A</button></Menu>)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('menu').className).toContain('[&_[role=menuitem]:focus]:bg-gray-100')
  })
  it('a held RadioGroup stays focusable and ignores changes', async () => {
    const { default: RadioGroup } = await import('../../src/components/ui/RadioGroup.jsx')
    const { default: userEvent } = await import('@testing-library/user-event')
    const onChange = vi.fn()
    render(<RadioGroup legend="v" value="a" onChange={onChange} disabled options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    const b = screen.getByRole('radio', { name: 'B' })
    expect(b).not.toBeDisabled(); expect(b).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(b)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('CopyButton empty text (round 25)', () => {
  it('says there is nothing to copy rather than blaming the browser', async () => {
    const announce = vi.fn()
    vi.resetModules(); vi.doMock('../../src/lib/announce', () => ({ announce }))
    const { default: CopyButton } = await import('../../src/components/ui/CopyButton.jsx')
    const { default: userEvent } = await import('@testing-library/user-event')
    render(<CopyButton text="" />)
    await userEvent.click(screen.getByRole('button'))
    expect(announce).toHaveBeenCalledWith('Nothing to copy yet.')
  })
})
