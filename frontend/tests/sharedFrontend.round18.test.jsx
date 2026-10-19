// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { render, screen } from '@testing-library/react'
import useLatestRequest from '../src/hooks/useLatestRequest'
import { announce } from '../src/lib/announce'
import Input from '../src/components/ui/Input'

afterEach(() => { vi.useRealTimers(); document.querySelectorAll('[data-announcer]').forEach(n => n.remove()) })

describe('useLatestRequest cancels, not just ignores', () => {
  it('aborts the previous load when a newer one begins', () => {
    const { result } = renderHook(() => useLatestRequest())
    const a = result.current()
    const b = result.current()
    expect(a.signal.aborted).toBe(true)
    expect(a()).toBe(false)
    expect(b.signal.aborted).toBe(false)
    expect(b()).toBe(true)
  })
  it('aborts the in-flight load on unmount', () => {
    const { result, unmount } = renderHook(() => useLatestRequest())
    const a = result.current()
    unmount()
    expect(a.signal.aborted).toBe(true)
    expect(a()).toBe(false)
  })
})

describe('announce keeps the newest message', () => {
  it('two announcements inside the first 50ms: the later one wins', () => {
    vi.useFakeTimers()
    announce('first')
    announce('second')
    vi.advanceTimersByTime(100)
    expect(document.querySelector('[data-announcer]').textContent.trim()).toBe('second')
  })
  it('a lone first announcement is still delivered', () => {
    vi.useFakeTimers()
    announce('only')
    vi.advanceTimersByTime(60)
    expect(document.querySelector('[data-announcer]').textContent.trim()).toBe('only')
  })
})

describe('shared Input keeps phones from zooming', () => {
  it('uses 16px text below the sm breakpoint', () => {
    render(<Input aria-label="Code" />)
    expect(screen.getByLabelText('Code').className).toContain('text-base')
  })
})
