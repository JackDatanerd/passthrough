// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, renderHook, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import axios from 'axios'
import { formatMoney, formatRate, scoreTier } from '../src/lib/utils'
import { shouldRetryRequest, getErrorMessage } from '../src/lib/errors'
import useLatestRequest from '../src/hooks/useLatestRequest'
import Select from '../src/components/ui/Select'
import Modal from '../src/components/ui/Modal'
import Pagination from '../src/components/ui/Pagination'
import DataTable from '../src/components/ui/DataTable'
import Input from '../src/components/ui/Input'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import Navbar from '../src/components/layout/Navbar'
import DashboardLayout from '../src/components/layout/DashboardLayout'
import { AuthContext } from '../src/context/AuthContext'

describe('utils: missing is not zero', () => {
  it('formatMoney drops the sign on amounts that round to zero and treats blanks as missing', () => {
    expect(formatMoney(-0.4)).toBe('$0.00')
    expect(formatMoney(-49, { decimals: 0 })).toBe('$0')
    expect(formatMoney(-150)).toBe('-$1.50')
    expect(formatMoney(' ')).toBe('—')
    expect(formatMoney(true)).toBe('—')
  })
  it('formatRate shows — for null/blank, still 0% for a real zero', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate('')).toBe('—')
    expect(formatRate(0)).toBe('0%')
  })
  it('scoreTier treats blank and boolean as unknown', () => {
    expect(scoreTier('')).toBe('unknown')
    expect(scoreTier(false)).toBe('unknown')
    expect(scoreTier(0)).not.toBe('unknown')
  })
})

describe('errors: cancel / no-config', () => {
  it('never retries without a method, or when cancelled', () => {
    expect(shouldRetryRequest({ method: undefined, hasResponse: false, alreadyRetried: false }).retry).toBe(false)
    expect(shouldRetryRequest({ method: 'get', hasResponse: false, alreadyRetried: false, cancelled: true }).retry).toBe(false)
    expect(shouldRetryRequest({ method: 'get', hasResponse: false, alreadyRetried: false }).retry).toBe(true)
  })
  it('a cancelled request is not reported as a connectivity problem', () => {
    expect(getErrorMessage(new axios.CanceledError('x'), 'fallback')).toBe('fallback')
  })
})

describe('useLatestRequest', () => {
  it('only the newest begin() is current, and nothing is current after unmount', () => {
    const { result, unmount } = renderHook(() => useLatestRequest())
    const a = result.current(); const b = result.current()
    expect(a()).toBe(false); expect(b()).toBe(true)
    unmount()
    expect(b()).toBe(false)
  })
})

describe('Select', () => {
  it('error state carries bg-red-50 and not bg-white (stylesheet order made bg-white win)', () => {
    const { container } = render(<Select label="L" error="bad"><option>a</option></Select>)
    const cls = container.querySelector('select').className
    expect(cls).toContain('bg-red-50'); expect(cls).not.toContain('bg-white')
    const ok = render(<Select label="L2"><option>a</option></Select>).container.querySelector('select').className
    expect(ok).toContain('bg-white')
  })
  it('keeps a caller aria-describedby alongside its own', () => {
    const { container } = render(<Input label="x" error="bad" aria-describedby="extra" />)
    expect(container.querySelector('input').getAttribute('aria-describedby')).toMatch(/-error extra$/)
  })
})

describe('Modal autofocus', () => {
  it('data-autofocus wins even when an input comes first in the DOM', () => {
    render(<Modal open onClose={() => {}} title="t"><input aria-label="first" /><button data-autofocus>safe</button></Modal>)
    expect(document.activeElement).toBe(screen.getByText('safe'))
  })
})

describe('Pagination', () => {
  it('renders nothing for a non-numeric totalPages', () => {
    const { container } = render(<Pagination page={1} totalPages={undefined} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('DataTable', () => {
  const cols = [{ key: 'a', header: 'A' }, { key: 'b', header: 'B', cell: r => `#${r.b}` }]
  it('renders caption, scoped headers and custom cells', () => {
    render(<DataTable caption="Things" columns={cols} rows={[{ id: 1, a: 'x', b: 2 }]} rowKey={r => r.id} />)
    expect(screen.getByRole('table', { name: 'Things' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('scope', 'col')
    expect(screen.getByText('#2')).toBeInTheDocument()
  })
  it('shows the empty message and the spinner state', () => {
    const { rerender } = render(<DataTable columns={cols} rows={[]} empty="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    rerender(<DataTable columns={cols} rows={[]} loading empty="Nothing here." />)
    expect(screen.queryByText('Nothing here.')).toBeNull()
  })
})

describe('Toast pause on hover', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  function Fire({ kind }) { const t = useToast(); return <button onClick={() => t[kind]('hello')}>go</button> }
  it('keeps a toast while hovered and dismisses it after leaving; errors outlast 4s', () => {
    render(<ToastProvider><Fire kind="info" /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    const box = screen.getByText('hello').closest('[aria-live]')
    fireEvent.mouseEnter(box)
    act(() => { vi.advanceTimersByTime(20000) })
    expect(screen.queryByText('hello')).toBeInTheDocument()
    fireEvent.mouseLeave(box)
    act(() => { vi.advanceTimersByTime(4100) })
    expect(screen.queryByText('hello')).toBeNull()
  })
  it('error toasts last longer than the 4s default', () => {
    render(<ToastProvider><Fire kind="error" /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByText('hello')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByText('hello')).toBeNull()
  })
})

describe('Navbar', () => {
  const wrap = (ui, path = '/') => render(<MemoryRouter initialEntries={[path]}><AuthContext.Provider value={{ user: { id: 1, role: 'USER' }, logout: () => {} }}>{ui}</AuthContext.Provider></MemoryRouter>)
  it('has a skip link and a mobile menu that exposes the hidden links', () => {
    wrap(<><Navbar /><main>body</main></>)
    expect(screen.getByText('Skip to content')).toHaveAttribute('href', '#main')
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getAllByText('For employers').length).toBeGreaterThan(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('DashboardLayout', () => {
  it('keeps a tab current on nested paths, but not Scans on its siblings', () => {
    render(<MemoryRouter initialEntries={['/dashboard/payments/abc']}><AuthContext.Provider value={{ user: { id: 1 }, logout: () => {} }}><DashboardLayout>x</DashboardLayout></AuthContext.Provider></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Payments' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Scans' })).not.toHaveAttribute('aria-current')
  })
})
