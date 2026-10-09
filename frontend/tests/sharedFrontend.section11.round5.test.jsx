// @vitest-environment jsdom
// Section 11, round 5 — one regression test per fix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent, renderHook, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../src/context/AuthContext'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import TermsUpdateBanner from '../src/components/layout/TermsUpdateBanner'
import DashboardLayout from '../src/components/layout/DashboardLayout'
import Alert from '../src/components/ui/Alert'
import Checkbox from '../src/components/ui/Checkbox'
import FileUpload from '../src/components/ui/FileUpload'
import DeliveredResumeEditor from '../src/components/scan/DeliveredResumeEditor'
import { useUnsavedChangesWarning } from '../src/hooks/useUnsavedChangesWarning'
import { setFlash, peekFlash, consumeFlash, FLASH_ADMIN_DENIED } from '../src/lib/flash'

vi.mock('../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

describe('Toast: pause state is reset when the stack empties (BUG: later toasts never auto-dismissed)', () => {
  let toast
  function Grab() { toast = useToast(); return null }
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hover -> dismiss with the X (no mouseleave delivered) -> the next toast still times out', () => {
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { toast.success('first') })
    fireEvent.mouseEnter(screen.getByText('first').closest('[aria-live]'))
    fireEvent.click(screen.getByLabelText('Dismiss notification'))
    act(() => { toast.info('second') })
    act(() => { vi.advanceTimersByTime(4_100) })
    expect(screen.queryByText('second')).toBeNull()
  })
  it('focus on the X -> dismissed by keyboard (no blur delivered) -> the next toast still times out', () => {
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { toast.success('first') })
    const btn = screen.getByLabelText('Dismiss notification')
    act(() => { btn.focus() })
    fireEvent.click(btn)
    act(() => { toast.info('second') })
    act(() => { vi.advanceTimersByTime(4_100) })
    expect(screen.queryByText('second')).toBeNull()
  })
  it('hovering still pauses an existing toast (the fix does not break pausing)', () => {
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { toast.info('stay') })
    fireEvent.mouseEnter(screen.getByText('stay').closest('[aria-live]'))
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByText('stay')).toBeInTheDocument()
    fireEvent.mouseLeave(screen.getByText('stay').closest('[aria-live]'))
    act(() => { vi.advanceTimersByTime(4_100) })
    expect(screen.queryByText('stay')).toBeNull()
  })
})

describe('TermsUpdateBanner releases the button when acceptance does not unmount it', () => {
  it('acceptTerms resolves but the user was not flipped (token swapped mid-request)', async () => {
    const acceptTerms = vi.fn().mockResolvedValue({ id: 'u1' })
    render(<MemoryRouter><AuthContext.Provider value={{ user: { id: 'u1', termsCurrent: false }, acceptTerms }}><TermsUpdateBanner /></AuthContext.Provider></MemoryRouter>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /i agree/i })) })
    await waitFor(() => expect(screen.getByRole('button', { name: /i agree/i })).not.toBeDisabled())
  })
  it('a failure still shows the error and re-enables the button', async () => {
    const acceptTerms = vi.fn().mockRejectedValue({ response: { data: { message: 'Nope' } } })
    render(<MemoryRouter><AuthContext.Provider value={{ user: { id: 'u1', termsCurrent: false }, acceptTerms }}><TermsUpdateBanner /></AuthContext.Provider></MemoryRouter>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /i agree/i })) })
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't record|nope/i)
    expect(screen.getByRole('button', { name: /i agree/i })).not.toBeDisabled()
  })
})

describe('DashboardLayout notice survives StrictMode and is shown only once', () => {
  const auth = { user: { id: 'u1', termsCurrent: true }, logout: vi.fn() }
  const mount = strict => {
    const tree = <MemoryRouter><AuthContext.Provider value={auth}><DashboardLayout>x</DashboardLayout></AuthContext.Provider></MemoryRouter>
    return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree)
  }
  it('shows under StrictMode (BUG: a render-phase consume lost it in development)', () => {
    setFlash(FLASH_ADMIN_DENIED)
    mount(true)
    expect(screen.getByText(/administrators/i)).toBeInTheDocument()
  })
  it('is cleared after mounting, so a later visit does not show it again', () => {
    setFlash(FLASH_ADMIN_DENIED)
    const first = mount(false)
    expect(screen.getByText(/administrators/i)).toBeInTheDocument()
    expect(peekFlash()).toBeNull()
    first.unmount()
    mount(false)
    expect(screen.queryByText(/administrators/i)).toBeNull()
  })
  it('peekFlash reads without clearing; consumeFlash clears', () => {
    setFlash(FLASH_ADMIN_DENIED)
    expect(peekFlash()).toBe(FLASH_ADMIN_DENIED); expect(peekFlash()).toBe(FLASH_ADMIN_DENIED)
    expect(consumeFlash()).toBe(FLASH_ADMIN_DENIED); expect(peekFlash()).toBeNull()
  })
})

describe('Alert keeps a caller-supplied text size (BUG: text-sm always beat text-xs)', () => {
  it('drops its default size when the caller sets one', () => {
    render(<Alert className="text-xs mb-2">hi</Alert>)
    const el = screen.getByRole('alert')
    expect(el.className).toMatch(/\btext-xs\b/); expect(el.className).not.toMatch(/\btext-sm\b/)
  })
  it('otherwise keeps text-sm; unrelated text-* utilities do not count as a size', () => {
    render(<Alert variant="info" className="text-center">a</Alert>)
    expect(screen.getByRole('status').className).toMatch(/\btext-sm\b/)
  })
})

describe('useUnsavedChangesWarning', () => {
  it('registers beforeunload only while dirty and removes it afterwards', () => {
    const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener')
    const { rerender, unmount } = renderHook(({ d }) => useUnsavedChangesWarning(d), { initialProps: { d: false } })
    expect(add.mock.calls.filter(c => c[0] === 'beforeunload')).toHaveLength(0)
    rerender({ d: true })
    expect(add.mock.calls.filter(c => c[0] === 'beforeunload')).toHaveLength(1)
    const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    rerender({ d: false })
    expect(remove.mock.calls.filter(c => c[0] === 'beforeunload')).toHaveLength(1)
    const ev2 = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(false)
    unmount(); add.mockRestore(); remove.mockRestore()
  })
})

describe('DeliveredResumeEditor protects an unsaved edit of a paid resume', () => {
  const scan = { id: 's1', fixTier: 'FIX_FULL', rewrittenResumeData: { name: 'Jane', experience: [], education: [], skills: ['SQL'] } }
  it('Cancel with no change closes straight away', async () => {
    const user = userEvent.setup()
    render(<DeliveredResumeEditor scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByText('Discard your changes?')).toBeNull()
  })
  it('Cancel after typing asks first; "Keep editing" keeps the text, "Discard" closes', async () => {
    const user = userEvent.setup()
    render(<DeliveredResumeEditor scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    await user.type(screen.getByLabelText('Name'), ' D')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Discard your changes?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Jane D')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByLabelText('Name')).toBeNull()
  })
  it('warns on page unload only while there are unsaved edits', async () => {
    const user = userEvent.setup()
    render(<DeliveredResumeEditor scan={scan} onSaved={vi.fn()} />)
    const fire = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(fire()).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    expect(fire()).toBe(false)
    await user.type(screen.getByLabelText('Name'), 'x')
    expect(fire()).toBe(true)
  })
})

describe('FileUpload: a file dropped outside the zone does not navigate the tab away', () => {
  const dragEvent = (type, types, target) => {
    const e = new Event(type, { bubbles: true, cancelable: true })
    e.dataTransfer = { types, files: [], dropEffect: 'copy' }
    target.dispatchEvent(e); return e
  }
  it('cancels file drags over the rest of the page, leaves the zone and non-file drags alone', () => {
    const { container } = render(<div><p data-testid="elsewhere">elsewhere</p><FileUpload onFile={vi.fn()} /></div>)
    const outside = screen.getByTestId('elsewhere')
    const over = dragEvent('dragover', ['Files'], outside)
    expect(over.defaultPrevented).toBe(true); expect(over.dataTransfer.dropEffect).toBe('none')
    expect(dragEvent('drop', ['Files'], outside).defaultPrevented).toBe(true)
    expect(dragEvent('dragover', ['text/plain'], outside).defaultPrevented).toBe(false)
    const zone = container.querySelector('[role="button"]')
    expect(dragEvent('dragover', ['Files'], zone).dataTransfer.dropEffect).toBe('copy')   // the guard stays out of the zone
  })
  it('removes its listeners when unmounted', () => {
    const { unmount } = render(<div><p data-testid="elsewhere">e</p><FileUpload onFile={vi.fn()} /></div>)
    const outside = screen.getByTestId('elsewhere')
    unmount()
    const host = document.body.appendChild(document.createElement('div'))
    expect(dragEvent('drop', ['Files'], host).defaultPrevented).toBe(false)
    expect(outside).toBeDefined()
  })
})

describe('Checkbox: description and error', () => {
  it('error is announced, marks the box invalid and is described-by; clicking it does not toggle', async () => {
    const user = userEvent.setup(); const onChange = vi.fn()
    render(<Checkbox label="I agree" error="Please accept." checked={false} onChange={onChange} />)
    const box = screen.getByRole('checkbox', { name: 'I agree' })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Please accept.')
    expect(box).toHaveAttribute('aria-invalid', 'true')
    expect(box.getAttribute('aria-describedby')).toBe(alert.id)
    await user.click(alert)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('no error -> no alert, no aria-invalid, no dangling aria-describedby', () => {
    render(<Checkbox label="Email me" description="Only the score summary." checked onChange={() => {}} />)
    const box = screen.getByRole('checkbox')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(box).not.toHaveAttribute('aria-invalid'); expect(box).not.toHaveAttribute('aria-describedby')
    expect(screen.getByText('Only the score summary.')).toBeInTheDocument()
    expect(screen.getByLabelText(/Email me/)).toBe(box)
  })
  it('a disabled labelled box does not look clickable', () => {
    render(<Checkbox label="Locked" disabled onChange={() => {}} />)
    expect(screen.getByText('Locked').closest('label').className).toMatch(/cursor-not-allowed/)
  })
})

describe('source guards (shared-frontend invariants that were silently broken before)', () => {
  const root = path.resolve(__dirname, '../src')
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  const files = walk(root).filter(f => f.endsWith('.jsx'))
  const rel = f => path.relative(root, f)

  it('error text rendered from an error variable is announced (role="alert") — unless an ancestor already is', () => {
    const bad = []
    const re = /<(p|div|span) className="[^"]*text-red-(?:600|700|800)[^"]*"[^>]*>\{[a-zA-Z.]*[eE]rr/
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (!re.test(l) || l.includes('role="alert"')) return
        const ctx = lines.slice(Math.max(0, i - 8), i).join('\n')
        if (/role="alert"|<Alert/.test(ctx)) return
        bad.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
  it('no error element is nested inside another live region (double announcement)', () => {
    const nested = []
    const re = /<p role="alert" className="[^"]*text-red/
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => { if (re.test(l) && /<div role="alert"/.test(lines.slice(Math.max(0, i - 3), i).join('\n'))) nested.push(`${rel(f)}:${i + 1}`) })
    }
    expect(nested).toEqual([])
  })
  it('every hand-written <table> has a caption and scoped column headers', () => {
    const bad = []
    for (const f of files) {
      if (rel(f).endsWith('components/ui/DataTable.jsx')) continue
      const s = fs.readFileSync(f, 'utf8')
      const tables = (s.match(/<table[\s>]/g) || []).length
      if (!tables) continue
      if ((s.match(/<caption[\s>]/g) || []).length < tables) bad.push(`${rel(f)}: caption`)
      if ((s.match(/<th(?![^>]*scope=)[\s>]/g) || []).length) bad.push(`${rel(f)}: th scope`)
    }
    expect(bad).toEqual([])
  })
  it('no native window.confirm is left in the app', () => {
    // Calls only — comments that describe the old behaviour are fine.
    const code = f => fs.readFileSync(f, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const bad = files.filter(f => /window\.confirm\(/.test(code(f))).map(rel)
    expect(bad).toEqual([])
  })
})
