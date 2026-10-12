// @vitest-environment jsdom
// Section 11, round 7 — latent shared-component fixes.
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Modal from '../src/components/ui/Modal'
import EmptyState from '../src/components/ui/EmptyState'
import ButtonLink from '../src/components/ui/ButtonLink'
import Pagination from '../src/components/ui/Pagination'
import Spinner from '../src/components/ui/Spinner'
import Navbar from '../src/components/layout/Navbar'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import { AuthContext } from '../src/context/AuthContext'
import { formatNumber } from '../src/lib/utils'

describe('Modal focus', () => {
  it('an autoFocus element inside the dialog keeps focus (it used to move to the first input)', () => {
    render(<Modal open title="t" onClose={() => {}}><input aria-label="first" /><input aria-label="second" autoFocus /></Modal>)
    expect(document.activeElement.getAttribute('aria-label')).toBe('second')
  })
  it('data-autofocus still outranks autoFocus', () => {
    render(<Modal open title="t" onClose={() => {}}><input aria-label="a" autoFocus /><button data-autofocus>go</button></Modal>)
    expect(document.activeElement.textContent).toBe('go')
  })
  it('with neither, the first input is focused as before', () => {
    render(<Modal open title="t" onClose={() => {}}><button>x</button><input aria-label="first" /></Modal>)
    expect(document.activeElement.getAttribute('aria-label')).toBe('first')
  })
  it('when the opener was removed, focus goes to <main>, not <body>', () => {
    function T() {
      const [open, setOpen] = useState(false); const [gone, setGone] = useState(false)
      return <main>{!gone && <button onClick={() => setOpen(true)}>open</button>}
        <Modal open={open} title="t" onClose={() => setOpen(false)}><button onClick={() => { setGone(true); setOpen(false) }}>del</button></Modal></main>
    }
    render(<T />)
    const b = screen.getByText('open'); b.focus(); fireEvent.click(b)
    fireEvent.click(screen.getByText('del'))
    expect(document.activeElement.tagName).toBe('MAIN')
  })
})

describe('EmptyState', () => {
  it('a block-level child is not nested inside a <p>', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<EmptyState><div>block</div></EmptyState>)
    expect(err).not.toHaveBeenCalled(); err.mockRestore()
  })
  it('text still renders in a <p>', () => { const { container } = render(<EmptyState>No rows</EmptyState>); expect(container.querySelector('p').textContent).toBe('No rows') })
  it("a caller's text colour replaces the default instead of sitting beside it", () => {
    const { container } = render(<EmptyState className="text-gray-400 italic">x</EmptyState>)
    const cls = container.firstChild.className
    expect(cls).toContain('text-gray-400'); expect(cls).not.toContain('text-gray-500')
  })
  it('keeps the default colour otherwise', () => { const { container } = render(<EmptyState className="mt-2">x</EmptyState>); expect(container.firstChild.className).toContain('text-gray-500') })
})

describe('ButtonLink disabled', () => {
  it('keeps aria-label / id / data-* but not navigation props', () => {
    render(<MemoryRouter><ButtonLink to="/x" disabled aria-label="Buy now" id="b1" data-x="1" onClick={() => {}}>Buy</ButtonLink></MemoryRouter>)
    const el = screen.getByRole('link', { name: 'Buy now' })
    expect(el.id).toBe('b1'); expect(el.getAttribute('data-x')).toBe('1'); expect(el.getAttribute('aria-disabled')).toBe('true'); expect(el.getAttribute('href')).toBeNull()
  })
})

describe('formatNumber', () => {
  it('blank and boolean are unknown, like formatMoney', () => { expect([formatNumber(' '), formatNumber(true), formatNumber(''), formatNumber(null)]).toEqual(['—', '—', '—', '—']); expect(formatNumber('1200')).toBe('1,200'); expect(formatNumber(0)).toBe('0') })
})

describe('Pagination landmark', () => {
  it('is a labelled <nav>, label overridable, count is a polite live region', () => {
    render(<Pagination page={2} totalPages={5} onChange={() => {}} ariaLabel="Payments pages" />)
    const nav = screen.getByRole('navigation', { name: 'Payments pages' })
    expect(nav.querySelector('[aria-live="polite"]').textContent).toBe('Page 2 of 5')
  })
  it('defaults to "Pagination"', () => { render(<Pagination page={1} totalPages={2} onChange={() => {}} />); expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy() })
})

describe('Spinner', () => { it('slows (not stops) under reduced motion', () => { const { container } = render(<Spinner />); expect(container.querySelector('svg').getAttribute('class')).toContain('motion-reduce:[animation-duration:3s]') }) })

describe('Toast', () => {
  function Fire({ fn }) { const t = useToast(); return <button onClick={() => fn(t)}>go</button> }
  it('an axios error becomes a person-readable message, not "Request failed with status code 500"', () => {
    render(<ToastProvider><Fire fn={t => t.error(Object.assign(new Error('Request failed with status code 500'), { isAxiosError: true, response: { status: 500, data: {} } }))} /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    expect(screen.getByRole('alert').textContent).toContain('The server had a problem')
    expect(screen.queryByText(/status code 500/)).toBeNull()
  })
  it('an action button runs its handler and dismisses the toast', () => {
    const undo = vi.fn()
    render(<ToastProvider><Fire fn={t => t({ message: 'Deleted', action: { label: 'Undo', onClick: undo } })} /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(undo).toHaveBeenCalledTimes(1); expect(screen.queryByText('Deleted')).toBeNull()
  })
  it('two toasts with an action are not merged; a plain duplicate still is', () => {
    render(<ToastProvider><Fire fn={t => { t({ message: 'Same', action: { label: 'Undo', onClick() {} } }); t({ message: 'Same', action: { label: 'Undo', onClick() {} } }); t({ message: 'Dup' }); t({ message: 'Dup' }) }} /></ToastProvider>)
    fireEvent.click(screen.getByText('go'))
    expect(screen.getAllByText('Same')).toHaveLength(2); expect(screen.getAllByText('Dup')).toHaveLength(1)
  })
})

describe('Navbar aria-current', () => {
  const at = path => render(<AuthContext.Provider value={{ user: { role: 'USER' }, logout() {} }}><MemoryRouter initialEntries={[path]}><Navbar /></MemoryRouter></AuthContext.Provider>)
  it('marks Dashboard on /dashboard/settings and nothing on /pricing for Dashboard', () => {
    at('/dashboard/settings')
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByRole('link', { name: 'Pricing' })[0].getAttribute('aria-current')).toBeNull()
  })
})
