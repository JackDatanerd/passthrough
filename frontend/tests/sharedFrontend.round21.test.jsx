// @vitest-environment jsdom
// SHARED FRONTEND (section 11, round 21): rate-limit wait time, focus continuity (Switch, referral box), live-region announcement for
// non-error alerts, toast reach inside a dialog, the shared file-drop guard, narrower step-up scope, longer /structure timeout, CSV
// and date hardening, useApi progress/retryAfter, RouteAnnouncer under StrictMode, and the session-resume username field.
import React, { StrictMode, useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, renderHook, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link, useNavigate } from 'react-router-dom'
import { getErrorMessage, getRetryAfterSeconds, formatWait } from '../src/lib/errors'
import api, { isStepUpUrl, LONG_REQUEST_TIMEOUT_MS } from '../src/lib/api'
import { csvCell, formatDate, formatDateTime } from '../src/lib/utils'
import { useApi } from '../src/hooks/useApi'
import useFileDropGuard from '../src/hooks/useFileDropGuard'
import Switch from '../src/components/ui/Switch'
import Alert from '../src/components/ui/Alert'
import Modal from '../src/components/ui/Modal'
import { ToastProvider, useToast } from '../src/components/ui/Toast'
import { ReferralCodeEntry } from '../src/components/ui/ReferralCodeEntry'
import RouteAnnouncer from '../src/components/layout/RouteAnnouncer'

const e429 = (headers, data = { message: 'Too many attempts.' }) => ({ isAxiosError: true, response: { status: 429, data, headers } })

describe('G1: a 429 says how long to wait', () => {
  it('reads Retry-After as seconds, as an HTTP date, and through an AxiosHeaders-style get()', () => {
    expect(getRetryAfterSeconds(e429({ 'retry-after': '900' }))).toBe(900)
    expect(getRetryAfterSeconds(e429({ 'Retry-After': '30' }))).toBe(30)
    expect(getRetryAfterSeconds(e429({ get: n => (n === 'retry-after' ? '120' : null) }))).toBe(120)
    const now = Date.parse('2026-10-20T10:00:00Z')
    expect(getRetryAfterSeconds(e429({ 'retry-after': 'Tue, 20 Oct 2026 10:05:00 GMT' }), now)).toBe(300)
  })
  it('ignores a missing, zero, negative or unreadable header', () => {
    for (const h of [undefined, {}, { 'retry-after': '' }, { 'retry-after': '0' }, { 'retry-after': 'soon' }, { 'retry-after': 'Mon, 01 Jan 2001 00:00:00 GMT' }])
      expect(getRetryAfterSeconds(e429(h))).toBeNull()
    expect(getRetryAfterSeconds(null)).toBeNull()
  })
  it('rounds the wait UP into plain words', () => {
    expect(formatWait(3)).toBe('a few seconds')
    expect(formatWait(31)).toBe('about 35 seconds')
    expect(formatWait(61)).toBe('about 2 minutes')
    expect(formatWait(900)).toBe('about 15 minutes')
    expect(formatWait(3600)).toBe('about 1 hour')
    expect(formatWait(3601)).toBe('about 2 hours')
    expect(formatWait(0)).toBe('')
  })
  it('appends the wait to the server message, and to the generic 429 line', () => {
    expect(getErrorMessage(e429({ 'retry-after': '900' }))).toBe('Too many attempts. Try again in about 15 minutes.')
    expect(getErrorMessage(e429({ 'retry-after': '900' }, {}))).toBe('Too many requests. Try again in about 15 minutes.')
  })
  it('does not repeat a time the server message already names, and leaves other statuses and header-less 429s alone', () => {
    expect(getErrorMessage(e429({ 'retry-after': '900' }, { message: 'Please wait 15 minutes.' }))).toBe('Please wait 15 minutes.')
    expect(getErrorMessage(e429({}))).toBe('Too many attempts.')
    expect(getErrorMessage(e429({}, {}))).toBe('Too many requests — please wait a moment and try again.')
    const e503 = { isAxiosError: true, response: { status: 503, data: { message: 'Busy.' }, headers: { 'retry-after': '5' } } }
    expect(getErrorMessage(e503)).toBe('Busy.')
  })
  it('useApi exposes retryAfter for a failed call and clears it on the next call and on reset', async () => {
    const { result } = renderHook(() => useApi())
    await act(async () => { await result.current.execute(() => Promise.reject(e429({ 'retry-after': '60' }))).catch(() => {}) })
    expect(result.current.retryAfter).toBe(60)
    expect(result.current.error).toMatch(/about 60 seconds|about 1 minute/)
    await act(async () => { await result.current.execute(() => Promise.resolve({ data: 1 })) })
    expect(result.current.retryAfter).toBeNull()
    await act(async () => { await result.current.execute(() => Promise.reject(e429({ 'retry-after': '60' }))).catch(() => {}) })
    act(() => result.current.reset())
    expect(result.current.retryAfter).toBeNull()
  })
})

describe('B6: useApi progress with an unknown upload size', () => {
  it('is null (indeterminate) while no real figure has arrived, and a stray event never regresses a real one', async () => {
    const { result } = renderHook(() => useApi())
    let opts, finish
    const p = new Promise(r => { finish = r })
    let call
    await act(async () => { call = result.current.execute(o => { opts = o; return p }, { progress: true }) })
    expect(result.current.progress).toBe(0)
    act(() => opts.onUploadProgress({ loaded: 5, total: 0 }))
    expect(result.current.progress).toBeNull()
    act(() => opts.onUploadProgress({ loaded: 50, total: 100 }))
    expect(result.current.progress).toBe(50)
    act(() => opts.onUploadProgress({ loaded: 60, total: 0 }))
    expect(result.current.progress).toBe(50)
    await act(async () => { finish({ data: 1 }); await call })
    expect(result.current.progress).toBeNull()
  })
})

describe('B7 / B8: API client scope and timeout', () => {
  it('sends step-up only to the admin-gated routes, not to the partner portal or the user\'s own payments', () => {
    for (const u of ['/admin/users', '/partners/abc/links', '/partners/payouts', '/partners/payout-export', '/payments/ref123/refund', '/payments/ref123/resolve', '/payments/ref123/recheck'])
      expect(isStepUpUrl(u), u).toBe(true)
    for (const u of ['/partners/notifications', '/partners/dashboard?x=1', '/partners/payout-details', '/partners/conversions', '/partners/apply', '/partners/accept-terms',
      '/payments/initialize', '/payments/verify?reference=a', '/payments/history', '/payments/pending', '/payments/ref123/cancel', '/payments/ref123/receipt', '/scan/1'])
      expect(isStepUpUrl(u), u).toBe(false)
  })
  it('gives the two-Claude-call /structure request longer than their worst case (2 x 90s)', () => {
    expect(LONG_REQUEST_TIMEOUT_MS).toBeGreaterThan(2 * 90_000)
    const seen = []
    api.defaults.adapter = c => { seen.push(c.timeout); return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: c }) }
    return api.post('/scan/1/structure', {}).then(() => expect(seen).toEqual([LONG_REQUEST_TIMEOUT_MS]))
  })
})

describe('B4 / B5: CSV and date hardening', () => {
  it('writes a negative amount given as a string as a number, and non-finite numbers as empty', () => {
    expect(csvCell('-12.00')).toBe('-12.00')
    expect(csvCell('-7')).toBe('-7')
    expect(csvCell(NaN)).toBe('')
    expect(csvCell(Infinity)).toBe('')
    expect(csvCell(-12)).toBe('-12')
  })
  it('still guards anything that could be a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('-1+1')).toBe("'-1+1")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('-12.00 USD')).toBe("'-12.00 USD")
  })
  it('refuses junk that merely contains a year, and keeps every real format', () => {
    expect(formatDate('foo 2026')).toBe('—')
    expect(formatDate(true)).toBe('—')
    expect(formatDateTime('foo 2026')).toBe('—')
    expect(formatDate(' 2026-09-01 ')).toBe('Sep 1, 2026')
    expect(formatDate('2026-09-01T12:00:00Z')).toMatch(/Sep 1, 2026/)
    expect(formatDate('2026-09-01T12:00:00.000+03:00')).toMatch(/Sep 1, 2026/)
    expect(formatDate('Sep 1, 2026')).toBe('Sep 1, 2026')
    expect(formatDate('Tue, 01 Sep 2026 10:00:00 GMT')).toMatch(/Sep 1, 2026/)
    expect(formatDate(new Date(2026, 8, 1))).toBe('Sep 1, 2026')
    expect(formatDate(Date.UTC(2026, 8, 1, 12))).toMatch(/Sep 1, 2026/)
  })
})

describe('B2: Switch keeps focus while it is disabled', () => {
  it('is aria-disabled, not natively disabled, stays focusable, and swallows clicks', async () => {
    const onChange = vi.fn()
    render(<Switch label="Email" checked onChange={onChange} disabled />)
    const sw = screen.getByRole('switch')
    expect(sw).not.toBeDisabled()
    expect(sw).toHaveAttribute('aria-disabled', 'true')
    sw.focus()
    expect(document.activeElement).toBe(sw)
    await userEvent.click(sw)
    await userEvent.keyboard(' ')
    expect(onChange).not.toHaveBeenCalled()
  })
  it('works as before when enabled and carries no aria-disabled', async () => {
    const onChange = vi.fn()
    render(<Switch label="Email" checked={false} onChange={onChange} />)
    const sw = screen.getByRole('switch')
    expect(sw).not.toHaveAttribute('aria-disabled')
    await userEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('B3: non-error alerts reach screen readers', () => {
  it('a status alert is a live region that exists before its text, and has the text and styling right after', async () => {
    const seen = []
    const mo = new MutationObserver(() => {})
    function Host() { const [m, setM] = useState(''); return (<><button onClick={() => setM('Saved.')}>go</button><Alert variant="success">{m}</Alert></>) }
    render(<Host />)
    expect(screen.queryByRole('status')).toBeNull()
    await userEvent.click(screen.getByText('go'))
    const region = screen.getByRole('status')
    expect(region).toHaveTextContent('Saved.')
    expect(region.className).toMatch(/bg-green-50/)
    mo.disconnect(); expect(seen).toEqual([])
  })
  it('the error variant is untouched: role=alert with its text immediately', () => {
    render(<Alert>Boom</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('Boom')
  })
  it('keeps focusOnShow working for a status alert', () => {
    render(<Alert variant="warning" focusOnShow>Careful</Alert>)
    expect(document.activeElement).toBe(screen.getByRole('status'))
  })
})

describe('B1: the referral box hands focus on', () => {
  it('Apply -> the "change" button; change -> the field; remove -> the field', async () => {
    function Host() {
      const [code, setCode] = useState('')
      return <ReferralCodeEntry referralCode={code} pricing={code ? { referralApplied: true } : null} onApply={setCode} />
    }
    render(<Host />)
    await userEvent.type(screen.getByLabelText('Referral code'), 'ABC')
    screen.getByRole('button', { name: 'Apply' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'change' }))
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByLabelText('Referral code'))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'change' }))
    screen.getByRole('button', { name: 'remove' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByLabelText('Referral code'))
  })
  it('does not grab focus on its own when nothing was done in it', () => {
    const outside = document.createElement('button'); document.body.appendChild(outside); outside.focus()
    render(<ReferralCodeEntry referralCode="ABC" pricing={{ referralApplied: true }} onApply={() => {}} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})

describe('G4: a toast raised inside a dialog can be reached with Tab', () => {
  it('Tab from the last dialog control lands on the toast\'s action button, then Dismiss, then wraps to the dialog', async () => {
    const onUndo = vi.fn()
    function Inner() {
      const toast = useToast()
      return (
        <Modal open onClose={() => {}} title="Edit">
          <button onClick={() => toast.success('Deleted', { action: { label: 'Undo', onClick: onUndo } })}>Delete</button>
        </Modal>
      )
    }
    render(<ToastProvider><Inner /></ToastProvider>)
    const del = screen.getByRole('button', { name: 'Delete' })
    await userEvent.click(del)
    const undo = await screen.findByRole('button', { name: 'Undo' })
    del.focus()
    const closeBtn = screen.getByRole('button', { name: 'Close' })
    // dialog order: Close (header) then Delete. Delete is the last dialog stop; Tab goes on to the toast.
    await userEvent.tab()
    expect(document.activeElement).toBe(undo)
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss notification' }))
    await userEvent.tab()
    expect(document.activeElement).toBe(closeBtn)
    await userEvent.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dismiss notification' }))
  })
  it('with no toast the trap is unchanged', async () => {
    render(<ToastProvider><Modal open onClose={() => {}} title="Edit"><button>One</button></Modal></ToastProvider>)
    screen.getByRole('button', { name: 'One' }).focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('B9: the shared file-drop guard', () => {
  function Host({ zone }) { useFileDropGuard(); return <div><div data-testid="zone" data-file-dropzone="">z</div><p data-testid="outside">o</p></div> }
  const drop = (el, type, types = ['Files']) => {
    const ev = new Event(type, { bubbles: true, cancelable: true }); ev.dataTransfer = { types, dropEffect: 'copy' }
    el.dispatchEvent(ev); return ev
  }
  it('cancels a file dropped outside any dropzone', () => {
    render(<Host />)
    expect(drop(screen.getByTestId('outside'), 'drop').defaultPrevented).toBe(true)
    const over = drop(screen.getByTestId('outside'), 'dragover')
    expect(over.defaultPrevented).toBe(true); expect(over.dataTransfer.dropEffect).toBe('none')
  })
  it('leaves a drop over a dropzone, and a non-file drag, alone; and stops guarding when unmounted', () => {
    const { unmount } = render(<Host />)
    expect(drop(screen.getByTestId('zone'), 'drop').defaultPrevented).toBe(false)
    expect(drop(screen.getByTestId('outside'), 'drop', ['text/plain']).defaultPrevented).toBe(false)
    const o = screen.getByTestId('outside'); unmount()
    expect(drop(document.body, 'drop').defaultPrevented).toBe(false); void o
  })
})

describe('RouteAnnouncer under StrictMode', () => {
  beforeEach(() => { document.title = 'Home' })
  it('stays silent on the initial load (dev double-effect) and still announces a real navigation', async () => {
    function Nav() { const go = useNavigate(); return <button onClick={() => { document.title = 'Pricing'; go('/pricing') }}>go</button> }
    render(<StrictMode><MemoryRouter><main><Nav /></main><RouteAnnouncer /></MemoryRouter></StrictMode>)
    const region = document.querySelector('[data-route-announcer]')
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(region.textContent).toBe('')
    await userEvent.click(screen.getByText('go'))
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    expect(region.textContent.trim()).toBe('Pricing')
  })
})
