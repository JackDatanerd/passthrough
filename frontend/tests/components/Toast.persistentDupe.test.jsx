// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider, useToast } from '../../src/components/ui/Toast'

afterEach(() => vi.useRealTimers())

// B2: a persistent toast (duration 0) that was repeated by a timed one used to start counting down and vanish.
describe('Toast: a repeat of a persistent message stays persistent', () => {
  it('keeps the toast after the timed repeat would have expired', () => {
    vi.useFakeTimers()
    let toast
    function Grab() { toast = useToast(); return null }
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { toast.error('Disk full', { duration: 0 }) })
    act(() => { toast.error('Disk full', { duration: 1000 }) })
    act(() => { vi.advanceTimersByTime(20000) })
    expect(screen.getAllByText('Disk full')).toHaveLength(1)
  })
})
