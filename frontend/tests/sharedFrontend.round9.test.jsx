// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { useState } from 'react'
import { render, screen, act, renderHook, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useApi } from '../src/hooks/useApi'
import Modal from '../src/components/ui/Modal'
import Radio from '../src/components/ui/Radio'
import Pagination from '../src/components/ui/Pagination'
import ProgressBar from '../src/components/ui/ProgressBar'
import Input from '../src/components/ui/Input'
import Select from '../src/components/ui/Select'
import Textarea from '../src/components/ui/Textarea'
import StatCard from '../src/components/ui/StatCard'
import { ToastProvider, useToast } from '../src/components/ui/Toast'

describe('useApi', () => {
  it('a failure that landed while a newer call was running is not wiped by that call succeeding', async () => {
    const { result } = renderHook(() => useApi())
    let failA, okB
    const A = new Promise((_, rej) => { failA = () => rej(Object.assign(new Error('x'), { response: { status: 400, data: { message: 'Save failed: name taken' } } })) })
    const B = new Promise(res => { okB = () => res({ data: {} }) })
    let pA, pB
    await act(async () => { pA = result.current.execute(() => A).catch(() => {}); pB = result.current.execute(() => B) })
    await act(async () => { failA(); await pA })
    await act(async () => { okB(); await pB })
    expect(result.current.error).toBe('Save failed: name taken')
  })

  it('a success that started AFTER the failure still clears it', async () => {
    const { result } = renderHook(() => useApi())
    await act(async () => { await result.current.execute(() => Promise.reject(new Error('boom'))).catch(() => {}) })
    expect(result.current.error).toBeTruthy()
    await act(async () => { await result.current.execute(() => Promise.resolve({ data: 1 })) })
    expect(result.current.error).toBeNull()
  })

  it('progress: opted-in calls get onUploadProgress, which feeds `progress`; it resets afterwards', async () => {
    const { result } = renderHook(() => useApi())
    let opts, finish
    const p = new Promise(r => { finish = r })
    let call
    await act(async () => { call = result.current.execute(o => { opts = o; return p }, { progress: true }) })
    expect(result.current.progress).toBe(0)
    expect(typeof opts.onUploadProgress).toBe('function')
    act(() => opts.onUploadProgress({ loaded: 25, total: 100 }))
    expect(result.current.progress).toBe(25)
    act(() => opts.onUploadProgress({ loaded: 5, total: 0 }))      // unknown size: ignored
    expect(result.current.progress).toBe(25)
    await act(async () => { finish({ data: 1 }); await call })
    expect(result.current.progress).toBeNull()
  })

  it('without the option nothing about the call changes', async () => {
    const { result } = renderHook(() => useApi())
    let opts
    await act(async () => { await result.current.execute(o => { opts = o; return Promise.resolve({ data: 1 }) }) })
    expect(opts.onUploadProgress).toBeUndefined()
    expect(result.current.progress).toBeNull()
  })
})

describe('Modal focus trap with a radio group', () => {
  it('Tab from the checked radio, the last tab stop, stays inside the dialog', async () => {
    const user = userEvent.setup()
    function App() {
      const [v, setV] = useState('b')
      return (
        <Modal open onClose={() => {}} title="Pick">
          <fieldset>
            {['a', 'b', 'c'].map(k => <Radio key={k} name="g" label={k.toUpperCase()} checked={v === k} onChange={() => setV(k)} />)}
          </fieldset>
        </Modal>
      )
    }
    render(<App />)
    screen.getByLabelText('B').focus()
    await user.tab()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })
})

describe('Toast', () => {
  function Fire({ fn }) { const t = useToast(); return <button onClick={() => fn(t)}>go</button> }
  const run = fn => { render(<ToastProvider><Fire fn={fn} /></ToastProvider>); fireEvent.click(screen.getByText('go')) }

  it('a blank error toast says something went wrong instead of drawing an empty box', () => {
    run(t => t.error(undefined))
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.')
  })
  it('a blank non-error toast is not shown', () => {
    run(t => { t.success(''); t.info('   ') })
    expect(screen.queryAllByRole('status').filter(n => n.textContent)).toHaveLength(0)
  })
  it('success and warning use colours that reach 4.5:1 with white text', () => {
    run(t => { t.success('saved'); t.warning('careful') })
    expect(screen.getByText('saved').parentElement.className).toContain('bg-green-700')
    expect(screen.getByText('careful').parentElement.className).toContain('bg-amber-700')
  })
})

describe('Pagination', () => {
  it('Prev from a page past the end lands on the last real page, not another missing one', () => {
    const onChange = vi.fn()
    render(<Pagination page={9} totalPages={3} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Prev' }))
    expect(onChange).toHaveBeenCalledWith(3)
  })
})

describe('ProgressBar', () => {
  it('is a labelled progressbar with a value and a text value', () => {
    render(<ProgressBar value={40} label="Uploading" />)
    const bar = screen.getByRole('progressbar', { name: 'Uploading' })
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    expect(bar).toHaveAttribute('aria-valuetext', 'Uploading 40%')
  })
  it('switches to the done label at 100 and clamps nonsense', () => {
    const { rerender } = render(<ProgressBar value={100} label="Uploading" doneLabel="Reading…" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Reading…')
    rerender(<ProgressBar value={250} label="Uploading" />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })
  it('without a value it is indeterminate (no aria-valuenow)', () => {
    render(<ProgressBar label="Working" />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  })
})

describe('small form controls and contrast', () => {
  it('size="sm" fields are 16px on phones (iOS Safari zooms the page on focus below that)', () => {
    render(<>
      <Input size="sm" aria-label="i" /><Textarea size="sm" aria-label="t" /><Select size="sm" aria-label="s"><option>x</option></Select>
    </>)
    for (const name of ['i', 't', 's']) expect(screen.getByLabelText(name).className).toMatch(/text-base/)
  })
  it('StatCard label and sub meet 4.5:1', () => {
    const { container } = render(<StatCard label="Clicks" value="3" sub="last 30 days" />)
    expect(container.innerHTML).not.toContain('text-gray-400')
  })
})
