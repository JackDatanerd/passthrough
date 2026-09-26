// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider, useToast } from '../../src/components/ui/Toast'

// Toast.jsx's own comments list several bugs found by hand: Date.now()-based
// ids colliding when two toasts fired in the same millisecond, auto-dismiss
// timers that weren't tracked/cleared (on manual close, on being capped off
// at 5, or on unmount), and the 5-toast cap itself. None of that had a
// regression test before this (Section 12 audit).
function Harness() {
  const toast = useToast()
  window.__toast = toast // exposed so tests can call it directly, same object every render
  return (
    <div>
      <button onClick={() => toast.success('Saved')}>fire-success</button>
      <button onClick={() => toast.error('Broke')}>fire-error</button>
    </div>
  )
}

function setup() {
  render(<ToastProvider><Harness /></ToastProvider>)
  return window.__toast
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  delete window.__toast
})

describe('Toast', () => {
  it('shows a message with the right role — status for info/success, alert for error', () => {
    const toast = setup()
    act(() => { toast.success('Saved') })
    expect(screen.getByRole('status')).toHaveTextContent('Saved')

    act(() => { toast.error('Broke') })
    expect(screen.getByRole('alert')).toHaveTextContent('Broke')
  })

  it('two toasts fired in the same tick both stay visible (no id collision)', () => {
    const toast = setup()
    act(() => {
      toast.info('First')
      toast.info('Second')
    })
    expect(screen.getByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('auto-dismisses after its duration, and duration:0 never auto-dismisses', () => {
    const toast = setup()
    act(() => { toast.show({ message: 'Goes away', duration: 1000 }) })
    act(() => { toast.show({ message: 'Stays', duration: 0 }) })
    expect(screen.getByText('Goes away')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByText('Goes away')).toBeNull()
    expect(screen.getByText('Stays')).toBeInTheDocument()

    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('Stays')).toBeInTheDocument() // still there, no timer was ever set
  })

  it('the X button dismisses immediately and cancels that toast\'s own timer', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const toast = setup()
    act(() => { toast.success('Dismiss me') })
    await user.click(screen.getByLabelText('Dismiss notification'))
    expect(screen.queryByText('Dismiss me')).toBeNull()

    // If the timer wasn't cleared, advancing past the default 4000ms duration
    // would call remove() again on an id already gone — harmless either way,
    // but nothing should be left to remove or throw.
    expect(() => act(() => { vi.advanceTimersByTime(5000) })).not.toThrow()
  })

  it('caps at 5 toasts on screen, dropping the oldest first', () => {
    const toast = setup()
    act(() => {
      for (let i = 1; i <= 6; i++) toast.info(`Toast ${i}`, { duration: 0 })
    })
    expect(screen.queryByText('Toast 1')).toBeNull() // oldest, dropped
    for (let i = 2; i <= 6; i++) expect(screen.getByText(`Toast ${i}`)).toBeInTheDocument()
  })

  it('a toast dropped by the cap does not fire a stray removal later', () => {
    const toast = setup()
    act(() => {
      for (let i = 1; i <= 6; i++) toast.info(`Toast ${i}`, { duration: 1000 })
    })
    // Toast 1 was capped off immediately; its timer must have been cleared,
    // not left to fire a no-op remove() once 1000ms passes.
    expect(() => act(() => { vi.advanceTimersByTime(1000) })).not.toThrow()
    expect(screen.queryByText('Toast 6')).toBeNull() // its own timer did fire and remove it
  })

  it('dismiss(id) removes a specific toast by id', () => {
    const toast = setup()
    let id
    act(() => { id = toast.show({ message: 'Target', duration: 0 }) })
    act(() => { toast.info('Other', { duration: 0 }) })
    act(() => { toast.dismiss(id) })
    expect(screen.queryByText('Target')).toBeNull()
    expect(screen.getByText('Other')).toBeInTheDocument()
  })

  it('useToast() throws when used outside a ToastProvider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Bare() { useToast(); return null }
    expect(() => render(<Bare />)).toThrow('useToast must be used within ToastProvider')
    errorSpy.mockRestore()
  })

  it('clears all pending timers on unmount without warning about state updates', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<ToastProvider><Harness /></ToastProvider>)
    act(() => { window.__toast.success('Bye', { duration: 1000 }) })
    unmount()
    act(() => { vi.advanceTimersByTime(2000) })
    const reactWarnings = errorSpy.mock.calls.filter(c => String(c[0]).includes('unmounted'))
    expect(reactWarnings).toHaveLength(0)
    errorSpy.mockRestore()
  })
})
