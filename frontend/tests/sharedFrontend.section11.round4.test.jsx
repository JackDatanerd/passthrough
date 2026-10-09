// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, renderHook, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'

import { getErrorMessage, isCancelError } from '../src/lib/errors'
import { formatDateTime } from '../src/lib/utils'
import { setFlash, consumeFlash, flashMessage, FLASH_ADMIN_DENIED } from '../src/lib/flash'
import { useApi } from '../src/hooks/useApi'
import Modal from '../src/components/ui/Modal'
import ConfirmDialog from '../src/components/ui/ConfirmDialog'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import Checkbox from '../src/components/ui/Checkbox'
import ButtonLink from '../src/components/ui/ButtonLink'
import FileUpload from '../src/components/ui/FileUpload'
import { ReferralCodeEntry } from '../src/components/ui/ReferralCodeEntry'
import DashboardLayout from '../src/components/layout/DashboardLayout'
import { AuthContext } from '../src/context/AuthContext'

// Section 11, round 4 (independent re-audit) — regression coverage for each fix.

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.style.cssText = ''; consumeFlash() })

describe('storage: memory fallback when setItem throws but getItem works (B1)', () => {
  it('a token that could not be persisted still reads back; remove clears it', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() { throw new Error('QuotaExceeded') }, removeItem() {} })
    const s = await import('../src/lib/storage')
    expect(s.setToken('a.b.c')).toBe(false)
    expect(s.getToken()).toBe('a.b.c')
    s.storageRemove('passthrough_token')
    expect(s.getToken()).toBeNull()
  })

  it('the device id stays stable instead of changing on every request', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() { throw new Error('QuotaExceeded') }, removeItem() {} })
    const s = await import('../src/lib/storage')
    const first = s.getDeviceId()
    expect(s.getDeviceId()).toBe(first)
  })

  it('a successful write drops the memory copy so storage stays the source of truth', async () => {
    vi.resetModules()
    const store = new Map()
    let failWrites = true
    vi.stubGlobal('localStorage', {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem(k, v) { if (failWrites) throw new Error('Quota'); store.set(k, String(v)) },
      removeItem: k => store.delete(k),
    })
    const s = await import('../src/lib/storage')
    s.setToken('old')
    failWrites = false
    s.setToken('new')
    store.set('passthrough_token', 'changed-elsewhere')
    expect(s.getToken()).toBe('changed-elsewhere')
  })
})

describe('errors / utils (B4, B5)', () => {
  it('a validation entry without a message is dropped, not rendered as "undefined"', () => {
    const err = { response: { status: 400, data: { errors: [{ field: 'email' }, { field: 'name', message: 'Required' }] } } }
    expect(getErrorMessage(err)).toBe('Name: Required')
    expect(getErrorMessage({ response: { status: 400, data: { errors: [{ field: 'email' }] } } }, 'Fallback')).toBe('Fallback')
  })

  it('a null/empty fallback means the default, and cancel errors are recognised', () => {
    expect(getErrorMessage({ response: { status: 404, data: {} } }, null)).toMatch(/something went wrong/i)
    expect(isCancelError({ code: 'ERR_CANCELED' })).toBe(true)
    expect(isCancelError({ name: 'AbortError' })).toBe(true)
    expect(isCancelError(new Error('x'))).toBe(false)
  })

  it('formatDateTime does not invent a time for a date-only value', () => {
    expect(formatDateTime('2026-09-01')).toBe('Sep 1, 2026')
    expect(formatDateTime('2026-09-01T14:30:00Z')).toMatch(/2026/)
  })
})

describe('flash', () => {
  it('is read once and has a message for the admin-denied code', () => {
    setFlash(FLASH_ADMIN_DENIED)
    expect(consumeFlash()).toBe(FLASH_ADMIN_DENIED)
    expect(consumeFlash()).toBeNull()
    expect(flashMessage(FLASH_ADMIN_DENIED)).toMatch(/administrators/i)
    expect(flashMessage('nope')).toBeNull()
  })
})

describe('useApi: cancel / abort / null options (B3)', () => {
  const cancelErr = () => Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })

  it('a cancelled call rethrows but never sets error', async () => {
    const { result } = renderHook(() => useApi())
    await act(async () => { await expect(result.current.execute(() => Promise.reject(cancelErr()))).rejects.toBeTruthy() })
    expect(result.current.error).toBeNull()
  })

  it('execute(fn, null) no longer throws on the options destructure', async () => {
    const { result } = renderHook(() => useApi())
    let out
    await act(async () => { out = await result.current.execute(() => Promise.resolve({ data: 1 }), null) })
    expect(out).toBe(1)
  })

  it('hands the call an AbortSignal and aborts it on unmount', async () => {
    const { result, unmount } = renderHook(() => useApi())
    let signal
    act(() => { result.current.execute(({ signal: s }) => { signal = s; return new Promise(() => {}) }).catch(() => {}) })
    expect(signal.aborted).toBe(false)
    unmount()
    expect(signal.aborted).toBe(true)
  })

  it('replace:true aborts the previous still-running call; without it both run', async () => {
    const { result } = renderHook(() => useApi())
    const signals = []
    const run = opts => act(() => { result.current.execute(({ signal }) => { signals.push(signal); return new Promise(() => {}) }, opts).catch(() => {}) })
    run(); run()
    expect(signals.map(s => s.aborted)).toEqual([false, false])
    run({ replace: true })
    expect(signals.map(s => s.aborted)).toEqual([true, true, false])
  })
})

describe('Modal (a11y + layout)', () => {
  it('names a title-less dialog and points at its description', () => {
    render(<Modal open ariaLabel="Photo viewer" describedBy="desc" onClose={() => {}}><p id="desc">Body</p></Modal>)
    const dlg = screen.getByRole('dialog')
    expect(dlg).toHaveAccessibleName('Photo viewer')
    expect(dlg).toHaveAttribute('aria-describedby', 'desc')
  })

  it('a hidden input is not a focus stop, so Tab still wraps inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Modal open title="T" onClose={() => {}}><button>First</button><input type="hidden" name="x" /></Modal>)
    const first = screen.getByRole('button', { name: 'First' })
    const close = screen.getByRole('button', { name: 'Close' })
    close.focus()
    await user.tab()       // Close -> First (last real stop is First, hidden input ignored)
    expect(document.activeElement).toBe(first)
    await user.tab()       // First is last -> wraps to Close
    expect(document.activeElement).toBe(close)
  })

  it('uses the visible-viewport max height', () => {
    render(<Modal open title="T" onClose={() => {}}>x</Modal>)
    expect(screen.getByRole('dialog').style.maxHeight).toBe('90dvh')
  })
})

describe('ConfirmDialog self-guarding', () => {
  it('ignores a double-click while the async action is running', async () => {
    const user = userEvent.setup()
    let release
    const onConfirm = vi.fn(() => new Promise(r => { release = r }))
    render(<ConfirmDialog open message="Sure?" onConfirm={onConfirm} onCancel={() => {}} />)
    const btn = screen.getByRole('button', { name: 'Confirm' })
    await user.dblClick(btn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
  })

  it('shows a rejection inside the dialog and stays usable for a retry', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockRejectedValueOnce({ response: { status: 500, data: {} } }).mockResolvedValue()
    render(<ConfirmDialog open message="Sure?" onConfirm={onConfirm} onCancel={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/server had a problem/i)
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('describes the dialog by its message', () => {
    render(<ConfirmDialog open message="Delete everything?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription('Delete everything?')
  })
})

describe('Toast', () => {
  let toast
  function Harness() { toast = useToast(); return null }
  beforeEach(() => { vi.useFakeTimers(); render(<ToastProvider><Harness /></ToastProvider>) })

  it('does not stack an identical message; it restarts the countdown on the one showing', () => {
    act(() => { toast.error('Network down'); toast.error('Network down') })
    expect(screen.getAllByText('Network down')).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(8000) })
    act(() => { toast.error('Network down') })               // restarts the 9s timer
    act(() => { vi.advanceTimersByTime(8000) })
    expect(screen.getByText('Network down')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1500) })
    expect(screen.queryByText('Network down')).toBeNull()
  })

  it('a toast that arrives while the stack is hovered waits until the pointer leaves', () => {
    act(() => { toast.info('first') })
    const region = screen.getByText('first').closest('[aria-live]')
    fireEvent.mouseEnter(region)
    act(() => { toast.info('second', { duration: 1000 }) })
    act(() => { vi.advanceTimersByTime(20000) })
    expect(screen.getByText('second')).toBeInTheDocument()
    fireEvent.mouseLeave(region)
    act(() => { vi.advanceTimersByTime(1100) })
    expect(screen.queryByText('second')).toBeNull()
  })

  it('an Error or object message renders as text instead of crashing', () => {
    act(() => { toast.error(new Error('Boom')); toast.info({ weird: true }) })
    expect(screen.getByText('Boom')).toBeInTheDocument()
    expect(screen.getByText('[object Object]')).toBeInTheDocument()
  })

  it('still caps at 5 and clears the timers of what was pushed off', () => {
    act(() => { for (let i = 1; i <= 7; i++) toast.info(`m${i}`) })
    expect(screen.queryByText('m1')).toBeNull()
    expect(screen.getByText('m7')).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(5)
  })
})

describe('Checkbox / ButtonLink', () => {
  it('Checkbox supports indeterminate and forwards the ref', () => {
    const ref = { current: null }
    const { rerender } = render(<Checkbox ref={ref} aria-label="all" indeterminate onChange={() => {}} />)
    expect(ref.current.indeterminate).toBe(true)
    rerender(<Checkbox ref={ref} aria-label="all" indeterminate={false} onChange={() => {}} />)
    expect(ref.current.indeterminate).toBe(false)
  })

  it('Checkbox applies wrapperClassName even without a label', () => {
    const { container } = render(<Checkbox aria-label="x" wrapperClassName="ml-2" onChange={() => {}} />)
    expect(container.querySelector('span.ml-2 input')).not.toBeNull()
  })

  it('ButtonLink renders a link, or an inert disabled element', () => {
    const { rerender } = render(<MemoryRouter><ButtonLink to="/x">Go</ButtonLink></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('href', '/x')
    rerender(<MemoryRouter><ButtonLink to="/x" disabled>Go</ButtonLink></MemoryRouter>)
    const el = screen.getByRole('link', { name: 'Go' })
    expect(el).toHaveAttribute('aria-disabled', 'true')
    expect(el).not.toHaveAttribute('href')
  })
})

describe('FileUpload', () => {
  it('clears a stale rejection when the parent changes the file, and takes custom copy', async () => {
    function Host() {
      const [f, setF] = useState(null)
      return <><button onClick={() => setF(new File(['x'], 'ok.pdf', { type: 'application/pdf' }))}>give</button>
        <FileUpload value={f} onFile={setF} prompt="Drop your CV" typesText="PDF only" ariaLabel="Upload CV" /></>
    }
    const { container } = render(<Host />)
    expect(screen.getByText(/Drop your CV/)).toBeInTheDocument()
    expect(screen.getByText(/PDF only, max 5MB/)).toBeInTheDocument()
    const input = container.querySelector('input[type=file]')
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.exe')] } })
    expect(screen.getByRole('alert')).toHaveTextContent(/only pdf and docx/i)
    await userEvent.click(screen.getByText('give'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('ReferralCodeEntry', () => {
  it('"change" has a way back that keeps the applied code', async () => {
    const user = userEvent.setup()
    const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="ABC" pricing={{ referralApplied: true, discountApplied: true }} onApply={onApply} />)
    await user.click(screen.getByRole('button', { name: 'change' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(/applied/i)).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
  })
})

describe('DashboardLayout notice', () => {
  const renderLayout = () => render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <AuthContext.Provider value={{ user: null, logout: () => {} }}>
        <DashboardLayout><p>Content</p></DashboardLayout>
      </AuthContext.Provider>
    </MemoryRouter>
  )
  it('shows the one-shot admin-denied notice once', () => {
    setFlash(FLASH_ADMIN_DENIED)
    const first = renderLayout()
    expect(screen.getByText(/administrators/i)).toBeInTheDocument()
    first.unmount()
    renderLayout()
    expect(screen.queryByText(/administrators/i)).toBeNull()
  })
})
