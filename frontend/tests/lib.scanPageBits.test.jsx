// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { loadJdDraft, saveJdDraft, clearJdDraft, dropForeignJdDraft } from '../src/lib/scanJdDraft'
import { titleFor, isPrivatePath } from '../src/lib/pageTitles'
import FocusShell from '../src/components/layout/FocusShell'
import { setToken } from '../src/lib/storage'
import PageShell from '../src/components/layout/PageShell'

const auth = { user: null, authLoading: false, logout: () => {} }
vi.mock('../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../src/lib/api', () => ({
  default: { get: vi.fn(async () => ({ data: { data: {} } })), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (e, f) => f,
}))
vi.mock('../src/components/layout/Footer', () => ({ default: () => <footer>footer</footer> }))

const KEY = 'passthrough_scan_jd_draft'
beforeEach(() => { localStorage.clear(); auth.user = null; auth.authLoading = false })

describe('scanJdDraft', () => {
  it('round-trips text and link, and forgets when both are empty', () => {
    saveJdDraft({ text: 'a job', url: '', useUrl: false })
    expect(loadJdDraft()).toEqual({ text: 'a job', url: '', useUrl: false })
    saveJdDraft({ text: '  ', url: ' ' })
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(loadJdDraft()).toBeNull()
  })
  it('keeps a draft for its owner only; one typed signed out belongs to whoever signs in', () => {
    saveJdDraft({ text: 'mine', owner: 'u1' })
    expect(loadJdDraft('u1')).not.toBeNull()
    expect(loadJdDraft('u2')).toBeNull()
    expect(loadJdDraft(null)).toBeNull()
    saveJdDraft({ text: 'anon' })
    expect(loadJdDraft('u9')).not.toBeNull()
  })
  it('drops a draft owned by someone else when a session is adopted, but not an anonymous one', () => {
    saveJdDraft({ text: 'mine', owner: 'u1' })
    dropForeignJdDraft('u2')
    expect(localStorage.getItem(KEY)).toBeNull()
    saveJdDraft({ text: 'anon' })
    dropForeignJdDraft('u2')
    expect(localStorage.getItem(KEY)).not.toBeNull()
    clearJdDraft()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('survives corrupt or missing storage', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadJdDraft()).toBeNull()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(() => saveJdDraft({ text: 'x' })).not.toThrow()
    spy.mockRestore()
  })
  it('caps what it stores', () => {
    saveJdDraft({ text: 'x'.repeat(50000) })
    expect(loadJdDraft().text).toHaveLength(20000)
  })
})

describe('page titles and privacy of /scan', () => {
  it('titles the form and the result differently', () => {
    expect(titleFor('/scan')).toBe('New scan — Passthrough')
    expect(titleFor('/scan/')).toBe('New scan — Passthrough')
    expect(titleFor('/scan/abc/why')).toBe('Your scan — Passthrough')
  })
  it('keeps both out of search', () => {
    expect(isPrivatePath('/scan')).toBe(true)
    expect(isPrivatePath('/scan/abc/resume')).toBe(true)
  })
})

describe('shells', () => {
  const at = (path, child) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="*" element={child} /></Routes></MemoryRouter>)

  it('FocusShell: logo home, Pricing, and Sign in that returns to this very page', () => {
    at('/scan/abc/why?token=t1', <FocusShell><p>body</p></FocusShell>)
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login?next=%2Fscan%2Fabc%2Fwhy%3Ftoken%3Dt1')
    expect(screen.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing')
    expect(screen.queryByText('How it works')).toBeNull()
    expect(screen.getByText('body')).toBeInTheDocument()
  })
  it('PageShell: a visitor gets the focus shell', () => {
    at('/scan', <PageShell><p>body</p></PageShell>)
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
  })
  it('PageShell: a signed-in person gets the app tabs, Scan before Scans', () => {
    auth.user = { id: 'u1', name: 'Ada', email: 'a@b.co' }
    at('/scan', <PageShell><p>body</p></PageShell>)
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    const scan = screen.getAllByRole('link', { name: 'Scan' })[0]
    expect(scan).toHaveAttribute('href', '/scan')
    expect(scan).toHaveAttribute('aria-current', 'page')
  })
  it('PageShell: while the session is being confirmed with a stored token, the app shell shows (no Sign in flash)', () => {
    setToken('t')
    auth.authLoading = true
    at('/scan', <PageShell><p>body</p></PageShell>)
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.getAllByRole('link', { name: 'Scan' }).length).toBeGreaterThan(0)
  })
})
