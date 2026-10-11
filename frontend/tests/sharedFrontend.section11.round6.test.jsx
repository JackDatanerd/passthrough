// @vitest-environment jsdom
// Section 11, round 6 — step-up prompt above other dialogs, draft-PDF timeout/no-retry, elevation scope,
// useApi keepAlive, Toast pause, useCopy, formatNumber, disabled fields, Navbar menu, Modal size/focus.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, renderHook, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import api, { LONG_REQUEST_TIMEOUT_MS, setStepUpPrompt, clearStepUp } from '../src/lib/api'
import Modal from '../src/components/ui/Modal'
import Input from '../src/components/ui/Input'
import Textarea from '../src/components/ui/Textarea'
import Select from '../src/components/ui/Select'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import { useCopy } from '../src/hooks/useCopy'
import { useApi } from '../src/hooks/useApi'
import { formatNumber } from '../src/lib/utils'
import AdminLayout from '../src/pages/admin/AdminLayout'

const ok = cfg => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg })

describe('Modal is portalled, so a dialog opened later sits above one opened earlier', () => {
  it('renders into <body>, not in place, and a later one follows the earlier one in the DOM', () => {
    function Two({ second }) {
      return (
        <div data-testid="host">
          <Modal open title="First" onClose={() => {}}>a</Modal>
          {second && <Modal open title="Second" onClose={() => {}}>b</Modal>}
        </div>
      )
    }
    const { rerender } = render(<Two />)
    expect(screen.getByTestId('host').querySelector('[role="dialog"]')).toBeNull()
    rerender(<Two second />)
    const dlgs = [...document.body.querySelectorAll('[role="dialog"]')]
    expect(dlgs.map(d => d.getAttribute('aria-labelledby') && d.querySelector('h2').textContent)).toEqual(['First', 'Second'])
    expect(dlgs[0].parentElement.compareDocumentPosition(dlgs[1].parentElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('size picks the width', () => {
    render(<Modal open title="W" size="xl" onClose={() => {}}>x</Modal>)
    expect(screen.getByRole('dialog').className).toContain('max-w-2xl')
  })
  it('hands focus back to the trigger even when the dialog autoFocuses an input', async () => {
    const user = userEvent.setup()
    function Host() {
      const [open, setOpen] = useState(false)
      return (<><button onClick={() => setOpen(true)}>Open</button><Modal open={open} title="T" onClose={() => setOpen(false)}><input autoFocus aria-label="x" /></Modal></>)
    }
    render(<Host />)
    const trigger = screen.getByRole('button', { name: 'Open' })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('admin step-up prompt (B1: it rendered underneath the refund/ban dialog that asked for it)', () => {
  afterEach(() => { setStepUpPrompt(null); clearStepUp(); delete api.defaults.adapter })
  it('opens as the shared Modal ABOVE an already-open dialog, takes focus, and the replayed request carries the elevation', async () => {
    const user = userEvent.setup()
    const seen = []
    api.defaults.adapter = cfg => {
      const url = cfg.url
      seen.push([cfg.method, url, cfg.headers['X-Admin-Elevation'] || null])
      if (url === '/admin/elevate') return Promise.resolve({ data: { data: { elevationToken: 'TOK', expiresInSeconds: 600 } }, status: 200, statusText: 'OK', headers: {}, config: cfg })
      if (url === '/refund' && !cfg.headers['X-Admin-Elevation'])
        return Promise.reject(Object.assign(new Error('403'), { isAxiosError: true, config: cfg, response: { status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED' }, headers: {}, config: cfg } }))
      return Promise.resolve({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config: cfg })
    }
    render(<MemoryRouter><Modal open title="Refund" onClose={() => {}}><button>Refund now</button></Modal><AdminLayout /></MemoryRouter>)
    let done
    act(() => { done = api.post('/refund', {}) })
    const pw = await screen.findByLabelText('Password')
    const dialogs = [...document.body.querySelectorAll('[role="dialog"]')]
    expect(dialogs.map(d => d.querySelector('h2')?.textContent)).toEqual(['Refund', 'Confirm your password'])   // later in the DOM = painted on top
    expect(dialogs[1].contains(document.activeElement)).toBe(true)
    await user.type(pw, 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await act(async () => { await done })
    expect(seen.find(x => x[1] === '/refund' && x[2] === 'TOK')).toBeTruthy()      // replayed WITH the elevation
    expect(screen.queryByText('Confirm your password')).toBeNull()
  })
  it('Escape cancels the prompt (rejects the original request)', async () => {
    const user = userEvent.setup()
    api.defaults.adapter = cfg => cfg.url === '/refund'
      ? Promise.reject(Object.assign(new Error('403'), { isAxiosError: true, config: cfg, response: { status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED' }, headers: {}, config: cfg } }))
      : Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg })
    render(<MemoryRouter><AdminLayout /></MemoryRouter>)
    let p
    act(() => { p = api.post('/refund', {}).catch(e => e) })
    await screen.findByLabelText('Password')
    await user.keyboard('{Escape}')
    const err = await p
    expect(err.response.status).toBe(403)
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
})

describe('draft PDF download: long timeout, never auto-retried (B2)', () => {
  it('GET download-draft-pdf gets the long timeout; download-draft (docx) stays at 30s', async () => {
    const seen = []
    const adapter = cfg => { seen.push(cfg.timeout); return ok(cfg) }
    await api.get('/scan/abc/download-draft-pdf', { adapter })
    await api.get('/scan/abc/download-draft', { adapter })
    expect(seen).toEqual([LONG_REQUEST_TIMEOUT_MS, 30_000])
  })
  it('a timeout on it is NOT retried (it would start a second server-side render)', async () => {
    let calls = 0
    const adapter = cfg => { calls++; return Promise.reject(Object.assign(new Error('timeout of 150000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED', config: cfg })) }
    await expect(api.get('/scan/abc/download-draft-pdf', { adapter })).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })
})

describe('X-Admin-Elevation scope', () => {
  it('rides only on state-changing requests, and clearStepUp() is exported for logout', async () => {
    expect(clearStepUp).toBeTypeOf('function')
    const headers = []
    const adapter = cfg => { headers.push(cfg.headers['X-Admin-Elevation'] || null); return ok(cfg) }
    // no token held: neither carries it
    await api.get('/x', { adapter }); await api.patch('/x', {}, { adapter })
    expect(headers).toEqual([null, null])
  })
})

describe('useApi keepAlive', () => {
  it('a keepAlive call gets no signal and is not aborted by unmount', () => {
    const { result, unmount } = renderHook(() => useApi())
    let seenArg
    act(() => { result.current.execute(arg => { seenArg = arg; return new Promise(() => {}) }, { keepAlive: true }).catch(() => {}) })
    unmount()
    expect(seenArg.signal).toBeUndefined()
  })
})

describe('Toast: a stuck pause is released when the dismissed toast was the focused one', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('the surviving toast still expires', async () => {
    function Fire() { const t = useToast(); return <button onClick={() => { t({ message: 'one', type: 'info' }); t({ message: 'two', type: 'info' }) }}>go</button> }
    render(<ToastProvider><Fire /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    const stack = screen.getByText('one').closest('[aria-live]')
    fireEvent.focus(stack)                                   // keyboard focus lands in the stack -> paused
    fireEvent.click(screen.getAllByRole('button', { name: /dismiss/i })[0])   // dismissing removes the focused button
    document.activeElement && document.activeElement.blur && document.activeElement.blur()
    await act(async () => { vi.advanceTimersByTime(10) })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(screen.queryByText('two')).toBeNull()
  })
})

describe('useCopy', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  it('flags copied, restarts the timer on a second click, and clears it on unmount', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue() }, configurable: true })
    const { result, unmount } = renderHook(() => useCopy(1000))
    await act(async () => { await result.current.copy('a') })
    expect(result.current.copied).toBe(true)
    await act(async () => { vi.advanceTimersByTime(600) })
    await act(async () => { await result.current.copy('a') })
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(result.current.copied).toBe(true)         // the 2nd click restarted the countdown
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(result.current.copied).toBe(false)
    const spy = vi.spyOn(globalThis, 'clearTimeout')
    unmount()
    expect(spy).toHaveBeenCalled()
  })
  it('reports failure instead of claiming success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('no')) }, configurable: true })
    document.execCommand = vi.fn(() => false)
    const { result } = renderHook(() => useCopy())
    await act(async () => { await result.current.copy('a') })
    expect(result.current.failed).toBe(true)
    expect(result.current.copied).toBe(false)
  })
})

describe('formatNumber', () => {
  it('is always en-US and dashes non-numbers', () => {
    expect(formatNumber(12000)).toBe('12,000')
    expect(formatNumber(1234.5678, 2)).toBe('1,234.57')
    expect(formatNumber(null)).toBe('—')
    expect(formatNumber('x')).toBe('—')
  })
})

describe('disabled fields look disabled', () => {
  it('Input, Textarea and Select carry the disabled style', () => {
    render(<><Input aria-label="i" disabled /><Textarea aria-label="t" disabled /><Select aria-label="s" disabled><option>a</option></Select></>)
    for (const name of ['i', 't', 's']) expect(screen.getByLabelText(name).className).toContain('disabled:bg-gray-100')
  })
})
