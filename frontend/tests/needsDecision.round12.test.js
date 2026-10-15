// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import api from '../src/lib/api'
import { loadNeedsDecision, resetNeedsDecision, useNeedsDecisionCount } from '../src/lib/needsDecision'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() } }))

// Profile & Dashboard round 12 (B6): the tab's "waiting" count shared one in-flight request between everyone,
// whoever started it and however old its answer.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const total = n => ({ data: { data: { total: n } } })
beforeEach(() => { api.get.mockReset(); resetNeedsDecision() })

describe('the Scans tab count', () => {
  it('a forced refresh asked for while an older request is still out is not answered with that older result', async () => {
    const first = deferred(), second = deferred()
    api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result } = renderHook(() => useNeedsDecisionCount('u1'))
    loadNeedsDecision('u1', { force: true })          // e.g. a scan was deleted just now
    first.resolve(total(3))                             // the answer read BEFORE that delete
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    second.resolve(total(2))
    await waitFor(() => expect(result.current).toBe(2))
  })
  it('several forced refreshes during one request cost one extra request, not one each', async () => {
    const first = deferred()
    api.get.mockReturnValueOnce(first.promise).mockResolvedValue(total(1))
    renderHook(() => useNeedsDecisionCount('u1'))
    loadNeedsDecision('u1', { force: true }); loadNeedsDecision('u1', { force: true }); loadNeedsDecision('u1', { force: true })
    first.resolve(total(4))
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    await new Promise(r => setTimeout(r, 30))
    expect(api.get).toHaveBeenCalledTimes(2)
  })
  it('a different person signing in while another person\'s request is out gets their own request and number', async () => {
    const mine = deferred(), theirs = deferred()
    api.get.mockReturnValueOnce(mine.promise).mockReturnValueOnce(theirs.promise)
    const { result, rerender } = renderHook(({ id }) => useNeedsDecisionCount(id), { initialProps: { id: 'u1' } })
    rerender({ id: 'u2' })
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
    mine.resolve(total(9))                              // u1's number must never reach u2
    theirs.resolve(total(5))
    await waitFor(() => expect(result.current).toBe(5))
  })
  it('an unforced call inside the freshness window reuses the number (no request)', async () => {
    api.get.mockResolvedValue(total(7))
    const { result } = renderHook(() => useNeedsDecisionCount('u1'))
    await waitFor(() => expect(result.current).toBe(7))
    await loadNeedsDecision('u1')
    expect(api.get).toHaveBeenCalledTimes(1)
  })
  it('a failed request is silent and leaves the count unknown', async () => {
    api.get.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useNeedsDecisionCount('u1'))
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})

// Profile & Dashboard B2: the Scans page's first-mount forced refresh queued a second identical request behind the tab
// strip's own first load.
describe('coalesced forced refresh (cold dashboard load)', () => {
  it('a coalesced force joins the request already out: one request, and nothing queued behind it', async () => {
    const first = deferred()
    api.get.mockReturnValueOnce(first.promise).mockResolvedValue(total(9))
    const { result } = renderHook(() => useNeedsDecisionCount('u1'))   // the tab strip's own first load
    loadNeedsDecision('u1', { force: true, coalesce: true })            // the Scans page, first render
    first.resolve(total(3))
    await waitFor(() => expect(result.current).toBe(3))
    await new Promise(r => setTimeout(r, 30))
    expect(api.get).toHaveBeenCalledTimes(1)
  })
  it('a coalesced force with nothing out still fetches (warm cache is not trusted), and a later plain force still queues a re-read', async () => {
    api.get.mockResolvedValue(total(1))
    await loadNeedsDecision('u1')
    await loadNeedsDecision('u1', { force: true, coalesce: true })
    expect(api.get).toHaveBeenCalledTimes(2)
    const slow = deferred()
    api.get.mockReset(); api.get.mockReturnValueOnce(slow.promise).mockResolvedValue(total(5))
    const p = loadNeedsDecision('u1', { force: true }); loadNeedsDecision('u1', { force: true })
    slow.resolve(total(2)); await p
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })
})
