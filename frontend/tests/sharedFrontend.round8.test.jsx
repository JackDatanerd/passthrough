// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../src/context/AuthContext'
import { formatMoney, formatCents, formatNumber, copyToClipboard, saveBlobResponse } from '../src/lib/utils'
import Input from '../src/components/ui/Input'
import Select from '../src/components/ui/Select'
import Textarea from '../src/components/ui/Textarea'
import Modal from '../src/components/ui/Modal'
import DataTable from '../src/components/ui/DataTable'
import Spinner from '../src/components/ui/Spinner'
import Navbar from '../src/components/layout/Navbar'
import useScrollToHash from '../src/hooks/useScrollToHash'

afterEach(() => { vi.restoreAllMocks() })

describe('formatters', () => {
  it('a lower-case currency code is still a currency code', () => {
    expect(formatMoney(1234, { currency: 'usd' })).toBe('$12.34')
    expect(formatCents(1234, 'kes')).toBe('12.34 KES')
  })
  it('never prints negative zero', () => {
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(-0.2)).toBe('0')
    expect(formatNumber(-3)).toBe('-3')
  })
})

describe('copyToClipboard fallback', () => {
  it('removes its scratch textarea even when execCommand throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = vi.fn(() => { throw new Error('nope') })
    expect(await copyToClipboard('abc')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})

describe('saveBlobResponse', () => {
  it('names the file after Content-Disposition, else the fallback, and revokes later', () => {
    vi.useFakeTimers()
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn()
    const names = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { names.push(this.download) })
    saveBlobResponse({ data: new Blob(['x']), headers: { 'content-disposition': 'attachment; filename="server-name.pdf"' } }, 'fallback.pdf')
    saveBlobResponse({ data: new Blob(['x']), headers: {} }, 'fallback.pdf')
    expect(names).toEqual(['server-name.pdf', 'fallback.pdf'])
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('required fields', () => {
  it('Input, Select and Textarea mark a required label with a hidden asterisk and keep the native required flag', () => {
    render(<>
      <Input label="Email" required />
      <Select label="Plan" required><option>a</option></Select>
      <Textarea label="Notes" required />
      <Input label="Optional" />
    </>)
    for (const name of [/Email/, /Plan/, /Notes/]) {
      const el = screen.getByLabelText(name)
      expect(el).toBeRequired()
    }
    expect(screen.getByText('Email').parentElement.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByText('Optional').querySelector('[aria-hidden="true"]')).toBeNull()
  })
})

describe('Modal Escape', () => {
  it('ignores an Escape an inner widget already handled, and one that ends IME composition', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="T"><input aria-label="x" /></Modal>)
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handled.preventDefault()
    document.dispatchEvent(handled)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    expect(onClose).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('DataTable', () => {
  it('makes its scrolling region keyboard-reachable and named by the caption', () => {
    render(<DataTable caption="Users" columns={[{ key: 'a', header: 'A' }]} rows={[{ a: 1 }]} rowKey={r => r.a} />)
    const region = screen.getByRole('region', { name: 'Users' })
    expect(region).toHaveAttribute('tabindex', '0')
  })
})

describe('Spinner', () => {
  it('carries its label as text the browser can announce', () => {
    render(<Spinner label="Loading scans" />)
    expect(screen.getByRole('status', { name: 'Loading scans' }).querySelector('title').textContent).toBe('Loading scans')
  })
})

describe('Navbar More menu', () => {
  const open = async () => {
    render(<MemoryRouter><AuthContext.Provider value={{ user: null, logout() {} }}><Navbar /><p>elsewhere</p></AuthContext.Provider></MemoryRouter>)
    const more = screen.getByRole('button', { name: 'More' })
    await userEvent.click(more)
    return more
  }
  it('Escape closes it and returns focus to the button', async () => {
    const more = await open()
    expect(document.getElementById('navbar-more')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.getElementById('navbar-more')).toBeNull()
    expect(more).toHaveFocus()
  })
  it('a press outside closes it', async () => {
    await open()
    fireEvent.pointerDown(screen.getByText('elsewhere'))
    expect(document.getElementById('navbar-more')).toBeNull()
  })
})

describe('useScrollToHash', () => {
  it('survives a malformed percent-escape in the hash', () => {
    function Probe() { useScrollToHash(); return <p>ok</p> }
    expect(() => render(<MemoryRouter initialEntries={['/#100%']}><Probe /></MemoryRouter>)).not.toThrow()
    expect(screen.getByText('ok')).toBeInTheDocument()
  })
})
