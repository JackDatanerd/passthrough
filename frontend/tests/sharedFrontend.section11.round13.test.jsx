// @vitest-environment jsdom
// Section 11, round 13 — char counter (gap), useApi progress ownership, masked-5xx copy.
import React, { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react'
import Input from '../src/components/ui/Input'
import Textarea from '../src/components/ui/Textarea'
import { useApi } from '../src/hooks/useApi'
import { getErrorMessage } from '../src/lib/errors'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

describe('showCount (Input / Textarea)', () => {
  it('renders nothing extra without showCount, or without a maxLength', () => {
    const { container, rerender } = render(<Textarea label="A" maxLength={10} defaultValue="abc" />)
    expect(container.textContent).not.toContain('/10')
    rerender(<Textarea label="A" showCount defaultValue="abc" />)
    expect(container.textContent).not.toContain('/')
  })
  it('shows n/limit for a controlled field and tracks typing', () => {
    function C() { const [v, setV] = useState('abc'); return <Textarea label="A" showCount maxLength={10} value={v} onChange={e => setV(e.target.value)} /> }
    render(<C />)
    expect(screen.getByText('3/10')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('A'), { target: { value: 'abcdef' } })
    expect(screen.getByText('6/10')).toBeTruthy()
  })
  it('tracks an uncontrolled field from its defaultValue and change events, and still calls the caller onChange', () => {
    let seen = 0
    render(<Input label="A" showCount maxLength={20} defaultValue="hello" onChange={() => { seen++ }} />)
    expect(screen.getByText('5/20')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('A'), { target: { value: 'hello world' } })
    expect(screen.getByText('11/20')).toBeTruthy()
    expect(seen).toBe(1)
  })
  it('says "approaching" at 90% and "reached" at the limit, in the status region', () => {
    function C() { const [v, setV] = useState('12345678'); return <Textarea label="A" showCount maxLength={10} value={v} onChange={e => setV(e.target.value)} /> }
    render(<C />)
    const status = () => screen.getByRole('status').textContent
    expect(status()).toBe('')
    fireEvent.change(screen.getByLabelText('A'), { target: { value: '123456789' } })
    expect(status()).toBe('Approaching the character limit')
    fireEvent.change(screen.getByLabelText('A'), { target: { value: '1234567890' } })
    expect(status()).toBe('Character limit reached')
  })
  it('reports a paste that the browser will cut, and clears it on the next edit', () => {
    function C() { const [v, setV] = useState('12345'); return <Textarea label="A" showCount maxLength={10} value={v} onChange={e => setV(e.target.value)} /> }
    render(<C />)
    const ta = screen.getByLabelText('A')
    ta.setSelectionRange(5, 5)
    fireEvent.paste(ta, { clipboardData: { getData: () => 'abcdefgh' } })        // 5 + 8 = 13 > 10 → 3 lost
    expect(screen.getByRole('status').textContent).toContain('cut by 3 characters')
    fireEvent.change(ta, { target: { value: '12345abcde' } })                      // the change the paste itself causes keeps the notice
    expect(screen.getByRole('status').textContent).toContain('cut by 3 characters')
    fireEvent.change(ta, { target: { value: '12345abcd' } })                       // the next edit clears it
    expect(screen.getByRole('status').textContent).not.toContain('cut by')
  })
  it('does not warn when the paste fits, or when it replaces a selection that makes room', () => {
    render(<Textarea label="A" showCount maxLength={10} defaultValue="12345" />)
    const ta = screen.getByLabelText('A')
    ta.setSelectionRange(0, 5)
    fireEvent.paste(ta, { clipboardData: { getData: () => 'abcdefghij' } })
    expect(screen.getByRole('status').textContent).not.toContain('cut by')
  })
  it('keeps the caller onBlur and clears the notice on blur', () => {
    let blurred = 0
    render(<Textarea label="A" showCount maxLength={4} defaultValue="1234" onBlur={() => { blurred++ }} />)
    const ta = screen.getByLabelText('A')
    ta.setSelectionRange(4, 4)
    fireEvent.paste(ta, { clipboardData: { getData: () => 'xx' } })
    expect(screen.getByRole('status').textContent).toContain('cut by 2')
    fireEvent.blur(ta)
    expect(blurred).toBe(1)
    expect(screen.getByRole('status').textContent).not.toContain('cut by')
  })
})

describe('useApi progress belongs to the call that started it', () => {
  it('another call starting mid-upload neither freezes the bar nor leaves it stuck', async () => {
    const { result } = renderHook(() => useApi())
    const upload = deferred(), other = deferred()
    let p1, p2, opts
    await act(async () => { p1 = result.current.execute(o => { opts = o; return upload.promise }, { progress: true }) })
    await act(async () => { opts.onUploadProgress({ loaded: 40, total: 100 }) })
    expect(result.current.progress).toBe(40)
    await act(async () => { p2 = result.current.execute(() => other.promise) })
    await act(async () => { opts.onUploadProgress({ loaded: 80, total: 100 }) })
    expect(result.current.progress).toBe(80)
    await act(async () => { upload.resolve({ data: 'ok' }); await p1 })
    expect(result.current.progress).toBe(null)
    await act(async () => { other.resolve({ data: 'x' }); await p2 })
    expect(result.current.progress).toBe(null)
  })
  it('a newer progress call takes over, and the older one finishing does not clear it', async () => {
    const { result } = renderHook(() => useApi())
    const a = deferred(), b = deferred()
    let pa, pb, oa, ob
    await act(async () => { pa = result.current.execute(o => { oa = o; return a.promise }, { progress: true }) })
    await act(async () => { pb = result.current.execute(o => { ob = o; return b.promise }, { progress: true }) })
    await act(async () => { ob.onUploadProgress({ loaded: 30, total: 100 }); oa.onUploadProgress({ loaded: 90, total: 100 }) })
    expect(result.current.progress).toBe(30)
    await act(async () => { a.resolve({ data: 1 }); await pa })
    expect(result.current.progress).toBe(30)
    await act(async () => { b.resolve({ data: 2 }); await pb })
    expect(result.current.progress).toBe(null)
  })
  it('a failed upload also returns progress to null', async () => {
    const { result } = renderHook(() => useApi())
    await act(async () => { await result.current.execute(() => Promise.reject(new Error('x')), { progress: true }).catch(() => {}) })
    expect(result.current.progress).toBe(null)
  })
})

describe('getErrorMessage on a masked server error', () => {
  const mk = (status, data) => ({ isAxiosError: true, response: { status, data } })
  it('the Worker\'s generic 5xx text yields to the friendly line', () => {
    expect(getErrorMessage(mk(500, { success: false, message: 'An error occurred.' }))).toBe('The server had a problem. Please try again in a moment.')
  })
  it('a deliberate 5xx message is still shown', () => {
    expect(getErrorMessage(mk(503, { success: false, message: 'Temporarily unavailable. Please try again in a moment.' }))).toBe('Temporarily unavailable. Please try again in a moment.')
    expect(getErrorMessage(mk(500, { success: false, message: 'Could not generate your PDF.' }))).toBe('Could not generate your PDF.')
  })
  it('the same text on a 4xx is left alone', () => {
    expect(getErrorMessage(mk(400, { success: false, message: 'An error occurred.' }))).toBe('An error occurred.')
  })
})
