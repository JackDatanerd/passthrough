// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useApi } from '../../src/hooks/useApi'

// useApi.js's own top comment documents three real, previously-shipped bugs:
// a single `loading` boolean that flipped false while a second call was
// still running, state updates firing after unmount, and (the one it names
// as an "audit" fix) a single `error` slot that a late-settling FIRST call
// could clobber over whatever a later-started call had just set. None of
// that had a regression test before this — see vitest.config.mjs and
// useReferralCapture.test.js's own comments for why. This is that coverage.
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => { vi.restoreAllMocks() })

describe('useApi', () => {
  it('resolves with the response body, loading true only while in flight, error stays null', async () => {
    const { result } = renderHook(() => useApi())
    const d = deferred()
    let out
    act(() => { out = result.current.execute(() => d.promise) })
    expect(result.current.loading).toBe(true)
    await act(async () => { d.resolve({ data: { ok: true } }) })
    await expect(out).resolves.toEqual({ ok: true })
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('sets a readable error and rethrows on failure', async () => {
    const { result } = renderHook(() => useApi())
    const d = deferred()
    let out
    act(() => { out = result.current.execute(() => d.promise) })
    const err = { response: { data: { message: 'Nope' } } }
    await act(async () => { d.reject(err) })
    await expect(out).rejects.toBe(err)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe('Nope')
  })

  it('loading stays true until BOTH overlapping calls finish, not just the first', async () => {
    const { result } = renderHook(() => useApi())
    const a = deferred(), b = deferred()
    act(() => { result.current.execute(() => a.promise) })
    act(() => { result.current.execute(() => b.promise) })
    expect(result.current.loading).toBe(true)
    await act(async () => { a.resolve({ data: 1 }) })
    expect(result.current.loading).toBe(true) // b is still pending
    await act(async () => { b.resolve({ data: 2 }) })
    expect(result.current.loading).toBe(false)
  })

  // The specific scenario useApi.js's "BUG FIX (audit)" comment describes:
  // call A starts, call B starts after it, B finishes first — then A, which
  // started EARLIER but settles LATER, must not overwrite what B just set.
  it('a late-failing earlier call cannot clobber a later call\'s successful result', async () => {
    const { result } = renderHook(() => useApi())
    const a = deferred(), b = deferred()
    let outA, outB
    act(() => { outA = result.current.execute(() => a.promise).catch(() => {}) })
    act(() => { outB = result.current.execute(() => b.promise) })
    await act(async () => { b.resolve({ data: 'b-won' }) })
    expect(result.current.error).toBeNull()
    await act(async () => { a.reject({ response: { data: { message: 'stale A failure' } } }) })
    await outA
    await outB
    expect(result.current.error).toBeNull() // A's late failure must not have set this
  })

  it('a late-succeeding earlier call cannot clear a later call\'s error', async () => {
    const { result } = renderHook(() => useApi())
    const a = deferred(), b = deferred()
    let outA, outB
    act(() => { outA = result.current.execute(() => a.promise) })
    act(() => { outB = result.current.execute(() => b.promise).catch(() => {}) })
    await act(async () => { b.reject({ response: { data: { message: 'b-failed' } } }) })
    expect(result.current.error).toBe('b-failed')
    await act(async () => { a.resolve({ data: 'stale A success' }) })
    await outA
    await outB
    expect(result.current.error).toBe('b-failed') // A's late success must not have cleared this
  })

  it('reset() clears the error', async () => {
    const { result } = renderHook(() => useApi())
    const d = deferred()
    act(() => { result.current.execute(() => d.promise).catch(() => {}) })
    await act(async () => { d.reject({ response: { data: { message: 'oops' } } }) })
    expect(result.current.error).toBe('oops')
    act(() => { result.current.reset() })
    expect(result.current.error).toBeNull()
  })

  it('does not update state (or warn) after the component unmounts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useApi())
    const d = deferred()
    let out
    act(() => { out = result.current.execute(() => d.promise).catch(() => {}) })
    unmount()
    await act(async () => { d.reject({ response: { data: { message: 'too late' } } }) })
    await out
    const reactWarnings = errorSpy.mock.calls.filter(c => String(c[0]).includes('unmounted'))
    expect(reactWarnings).toHaveLength(0)
  })
})
