// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({})) } }))

// localStorage can be blocked (some in-app browsers). Every route change that still carries
// ?ref= must then NOT re-fire a click: nothing is persisted, so only the in-memory guard stops it.
describe('useReferralCapture with blocked storage', () => {
  beforeEach(() => {
    vi.resetModules()
    api.post.mockClear()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked') })
  })

  it('tracks a code once per page session even when nothing can be stored', async () => {
    const { useReferralCapture } = await import('../src/hooks/useReferralCapture')
    const { result } = renderHook(() => { useReferralCapture(); return useNavigate() },
      { wrapper: ({ children }) => <MemoryRouter initialEntries={['/?ref=coach20']}>{children}</MemoryRouter> })
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith('/partners/track-click', { code: 'COACH20' })
    result.current('/pricing?ref=coach20')
    result.current('/?ref=COACH20&x=1')
    await new Promise(r => setTimeout(r, 20))
    expect(api.post).toHaveBeenCalledTimes(1)
  })
})
