// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import usePageClamp from '../../src/hooks/usePageClamp'

// The reachable bug: filtered to ACTIVE users, ban the only user on page 2 — the list reloads with a
// total that has only one page, <Pagination> renders nothing for one page, and the person is left
// on an empty page 2 with no controls. The hook pulls `page` back in range.
describe('usePageClamp', () => {
  const run = props => { const setPage = vi.fn(); renderHook(() => usePageClamp({ pageSize: 25, setPage, ...props })); return setPage }

  it('moves back to the last real page when the list shrank', () => {
    expect(run({ page: 2, total: 25, loading: false })).toHaveBeenCalledWith(1)
    expect(run({ page: 5, total: 60, loading: false })).toHaveBeenCalledWith(3)
  })
  it('does nothing while a valid page is shown', () => {
    expect(run({ page: 2, total: 60, loading: false })).not.toHaveBeenCalled()
    expect(run({ page: 1, total: 0, loading: false })).not.toHaveBeenCalled()
  })
  it('waits for the load to finish, so it never acts on a total about to be replaced', () => {
    expect(run({ page: 3, total: 10, loading: true })).not.toHaveBeenCalled()
  })
})
