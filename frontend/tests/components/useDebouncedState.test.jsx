// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import useDebouncedState from '../../src/hooks/useDebouncedState'

describe('useDebouncedState', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('value follows every keystroke; committed only follows once typing pauses', () => {
    const { result } = renderHook(() => useDebouncedState('', 350))
    act(() => result.current.setValue('a'))
    act(() => { vi.advanceTimersByTime(200) })
    act(() => result.current.setValue('ab'))
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current.value).toBe('ab')
    expect(result.current.committed).toBe('')            // the second keystroke restarted the wait
    act(() => { vi.advanceTimersByTime(150) })
    expect(result.current.committed).toBe('ab')
  })

  it('onCommit runs once per commit, in the same render as the committed value (one render, one request)', () => {
    const seen = []
    const onCommit = vi.fn(v => seen.push(v))
    let renders = 0
    const { result } = renderHook(() => { renders++; return useDebouncedState('', 100, onCommit) })
    act(() => result.current.setValue('x'))
    const before = renders
    act(() => { vi.advanceTimersByTime(100) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['x'])
    expect(renders - before).toBe(1)                      // committed + whatever onCommit set were batched
    expect(result.current.committed).toBe('x')
  })

  it('typing A -> B -> back to A inside the window commits nothing', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedState('a', 100, onCommit))
    act(() => result.current.setValue('ab'))
    act(() => { vi.advanceTimersByTime(50) })
    act(() => result.current.setValue('a'))
    act(() => { vi.advanceTimersByTime(500) })
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.committed).toBe('a')
  })

  it('commitNow skips the wait, reads the latest value, and does not double-commit afterwards', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() => useDebouncedState('', 350, onCommit))
    act(() => result.current.setValue('jo'))
    act(() => result.current.commitNow())
    expect(result.current.committed).toBe('jo')
    expect(onCommit).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onCommit).toHaveBeenCalledTimes(1)             // the pending timer was cancelled by the commit
    act(() => result.current.commitNow())                  // nothing new to commit
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('uses the latest onCommit and clears its timer on unmount', () => {
    const first = vi.fn(), second = vi.fn()
    const { result, rerender, unmount } = renderHook(({ cb }) => useDebouncedState('', 100, cb), { initialProps: { cb: first } })
    act(() => result.current.setValue('q'))
    rerender({ cb: second })
    act(() => { vi.advanceTimersByTime(100) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('q')
    act(() => result.current.setValue('qq'))
    unmount()
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
