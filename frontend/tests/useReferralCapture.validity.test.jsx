// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn() } }))

// Section 4 round 6: `?ref=` is a generic query parameter. A value the server says is not a real partner code
// must not overwrite (or extend) the real attribution the visitor arrived with.
const KEY = 'passthrough_referral_code'
const REAL = JSON.stringify({ code: 'COACH20', capturedAt: Date.now() - 5 * 24 * 3600 * 1000 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function visit(entry) {
  const mod = await import('../src/hooks/useReferralCapture')
  const r = renderHook(() => { mod.useReferralCapture(); return useNavigate() },
    { wrapper: ({ children }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter> })
  return { mod, ...r }
}

beforeEach(() => {
  vi.resetModules()
  api.post.mockReset()
  localStorage.clear()
  window.history.pushState({}, '', '/')
})

describe('useReferralCapture — junk ?ref= values', () => {
  it('puts the real code back EXACTLY as it was (same captured-at) when the server says the new one is not real', async () => {
    localStorage.setItem(KEY, REAL)
    api.post.mockResolvedValue({ data: { success: true, valid: false } })
    const { mod } = await visit('/?ref=producthunt')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBe(REAL))
    expect(mod.getStoredReferralCode()).toBe('COACH20')
  })

  it('with nothing stored before, a junk code leaves nothing stored', async () => {
    api.post.mockResolvedValue({ data: { success: true, valid: false } })
    const { mod } = await visit('/?ref=twitter')
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
    expect(mod.getStoredReferralCode()).toBe('')
  })

  it('keeps a code the server confirms', async () => {
    api.post.mockResolvedValue({ data: { success: true, valid: true } })
    const { mod } = await visit('/?ref=newcode')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 10))
    expect(mod.getStoredReferralCode()).toBe('NEWCODE')
  })

  it('keeps the code when the server says nothing about validity (older server / lookup failed)', async () => {
    api.post.mockResolvedValue({ data: { success: true } })
    const { mod } = await visit('/?ref=newcode')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 10))
    expect(mod.getStoredReferralCode()).toBe('NEWCODE')
  })

  it('keeps the code when the click call fails outright', async () => {
    api.post.mockRejectedValue(new Error('offline'))
    const { mod } = await visit('/?ref=newcode')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 10))
    expect(mod.getStoredReferralCode()).toBe('NEWCODE')
  })

  it('a code already rejected this session is never stored or tracked again on later navigation', async () => {
    localStorage.setItem(KEY, REAL)
    api.post.mockResolvedValue({ data: { success: true, valid: false } })
    const { result } = await visit('/?ref=twitter')
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBe(REAL))
    result.current('/pricing?ref=twitter')
    result.current('/?ref=TWITTER&x=1')
    await new Promise(r => setTimeout(r, 20))
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(KEY)).toBe(REAL)
  })

  it('a code the visitor typed in by hand before the answer arrives is not clobbered by the restore', async () => {
    localStorage.setItem(KEY, REAL)
    const d = deferred()
    api.post.mockReturnValue(d.promise)
    const { mod } = await visit('/?ref=twitter')
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled())
    mod.setStoredReferralCode('manual10')
    d.resolve({ data: { success: true, valid: false } })
    await new Promise(r => setTimeout(r, 10))
    expect(mod.getStoredReferralCode()).toBe('MANUAL10')
  })

  it('a repeat visit with the same real code refreshes its window without another click', async () => {
    localStorage.setItem(KEY, REAL)
    const { result } = await visit('/?ref=coach20')
    await new Promise(r => setTimeout(r, 10))
    expect(api.post).not.toHaveBeenCalled()
    const refreshed = JSON.parse(localStorage.getItem(KEY))
    expect(refreshed.code).toBe('COACH20')
    expect(refreshed.capturedAt).toBeGreaterThan(JSON.parse(REAL).capturedAt)
    result.current('/pricing')
  })
})
