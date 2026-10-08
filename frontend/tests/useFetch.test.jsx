// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../src/lib/api', () => ({ default: { get: vi.fn() }, getErrorMessage: (e, f) => f || e.message }))
import api from '../src/lib/api'
import useFetch from '../src/hooks/useFetch'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

describe('useFetch', () => {
  it('latest request wins: a slow earlier response cannot overwrite a newer one', async () => {
    const first = deferred()
    api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ data: { data: ['page2'], meta: { total: 1 } } })
    const { result, rerender } = renderHook(({ page }) => useFetch('/x', { page }), { initialProps: { page: 1 } })
    rerender({ page: 2 })
    await waitFor(() => expect(result.current.data).toEqual(['page2']))
    first.resolve({ data: { data: ['page1'], meta: { total: 1 } } })
    await new Promise(r => setTimeout(r, 10))
    expect(result.current.data).toEqual(['page2'])
    expect(result.current.loading).toBe(false)
  })
  it('does not refetch when only the params object identity changes', async () => {
    api.get.mockReset(); api.get.mockResolvedValue({ data: { data: [1] } })
    const { result, rerender } = renderHook(() => useFetch('/y', { a: 1 }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender(); rerender()
    expect(api.get).toHaveBeenCalledTimes(1)
  })
  it('surfaces an error message and skips when url is null', async () => {
    api.get.mockReset(); api.get.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useFetch('/z', null, { fallback: 'Nope' }))
    await waitFor(() => expect(result.current.error).toBe('Nope'))
    api.get.mockClear()
    renderHook(() => useFetch(null))
    expect(api.get).not.toHaveBeenCalled()
  })
})
