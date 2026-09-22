import { describe, it, expect, vi } from 'vitest'
import { runInBackground } from '../src/lib/background.js'

// Zero test coverage previously despite being the only thing standing
// between "fire and forget" background work and Cloudflare silently
// cancelling it once the response has been sent.

describe('runInBackground', () => {
  it('registers the promise with c.executionCtx.waitUntil and returns true', async () => {
    const waitUntil = vi.fn()
    const c = { executionCtx: { waitUntil } }
    const p = Promise.resolve('done')

    const registered = runInBackground(c, p)

    expect(registered).toBe(true)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    await waitUntil.mock.calls[0][0] // should not throw
  })

  it('returns false (rather than throwing) when c.executionCtx access itself throws', () => {
    const c = { get executionCtx() { throw new Error('no execution context') } }
    expect(runInBackground(c, Promise.resolve())).toBe(false)
  })

  it('returns false when executionCtx exists but has no waitUntil', () => {
    const c = { executionCtx: {} }
    expect(runInBackground(c, Promise.resolve())).toBe(false)
  })

  it('a rejecting promise never becomes an unhandled rejection', async () => {
    const waitUntil = vi.fn()
    const c = { executionCtx: { waitUntil } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    runInBackground(c, Promise.reject(new Error('boom')))
    await waitUntil.mock.calls[0][0] // the wrapped promise resolves, never throws

    expect(spy).toHaveBeenCalledWith('Background task failed:', 'boom')
    spy.mockRestore()
  })

  it('accepts a non-promise value without throwing', () => {
    const waitUntil = vi.fn()
    const c = { executionCtx: { waitUntil } }
    expect(runInBackground(c, 'not a promise')).toBe(true)
  })
})
