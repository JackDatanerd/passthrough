// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, useEffect, useRef } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext } from '../../src/context/AuthContext'
import api from '../../src/lib/api'
import { resetNeedsDecision } from '../../src/lib/needsDecision'
import { setToken } from '../../src/lib/storage'
import PageShell from '../../src/components/layout/PageShell'
import Alert from '../../src/components/ui/Alert'
import { previewOf } from '../../src/components/ui/ExpandableText'
import { formatMonthDay, formatTimeOfDay, filenameFromDisposition } from '../../src/lib/utils'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), defaults: { baseURL: '/api' } },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

beforeEach(() => {
  api.get.mockReset(); resetNeedsDecision()
  api.get.mockResolvedValue({ data: { data: { scans: [], total: 0 } } })
  localStorage.clear()
})

describe('PageShell keeps the page mounted when the header changes (round 27)', () => {
  it('a dead token swaps the header but does not rebuild the page', () => {
    setToken('stale-token')
    let mounts = 0
    function Page() {
      const [text, setText] = useState('')
      const first = useRef(true)
      useEffect(() => { if (first.current) { first.current = false; mounts++ } }, [])
      return <input aria-label="job" value={text} onChange={e => setText(e.target.value)} />
    }
    const wrap = auth => (
      <MemoryRouter initialEntries={['/scan']}>
        <AuthContext.Provider value={{ logout: vi.fn(), ...auth }}>
          <PageShell><Page /></PageShell>
        </AuthContext.Provider>
      </MemoryRouter>
    )
    const { rerender } = render(wrap({ user: null, authLoading: true }))
    // token stored + /auth/me pending -> the app header
    expect(screen.getByRole('navigation', { name: 'Dashboard' })).toBeInTheDocument()
    act(() => { screen.getByLabelText('job').focus() })
    userEvent.setup()
    const input = screen.getByLabelText('job')
    input.value = ''
    // type through React so the controlled value updates
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'pasted job description')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(screen.getByLabelText('job')).toHaveValue('pasted job description')
    // /auth/me refuses the token
    rerender(wrap({ user: null, authLoading: false }))
    expect(screen.queryByRole('navigation', { name: 'Dashboard' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText('job')).toHaveValue('pasted job description')
    expect(mounts).toBe(1)
  })
})

describe('Alert action (round 27)', () => {
  it('draws one typed button that runs the handler', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Alert action={{ label: 'Try again', onClick }}>Could not load.</Alert>)
    const btn = screen.getByRole('button', { name: 'Try again' })
    expect(btn).toHaveAttribute('type', 'button')
    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load. Try again')
  })
  it('busy keeps focus and swallows the click', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Alert action={{ label: 'Retry', onClick, busy: true }}>Failed.</Alert>)
    const btn = screen.getByRole('button', { name: 'Retry' })
    btn.focus()
    await user.click(btn)
    expect(onClick).not.toHaveBeenCalled()
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveFocus()
  })
  it('an action never makes an empty message show', () => {
    const { container } = render(<Alert action={{ label: 'Retry', onClick() {} }}>{''}</Alert>)
    expect(container).toBeEmptyDOMElement()
  })
  it('a non-error variant carries the action too', async () => {
    render(<Alert variant="info" action={{ label: 'Undo', onClick() {} }}>Archived.</Alert>)
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
  it('ignores a malformed action', () => {
    render(<Alert action={{ label: 'x' }}>Failed.</Alert>)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('date helpers guard like formatDate (round 27)', () => {
  it('null / 0 / false / true / a stray number are null, not the epoch', () => {
    for (const v of [null, undefined, '', 0, false, true, 'foo', '12', NaN, [], {}]) {
      expect(formatMonthDay(v)).toBeNull()
      expect(formatTimeOfDay(v)).toBeNull()
    }
  })
  it('an impossible calendar day is null', () => {
    expect(formatMonthDay('2026-02-30')).toBeNull()
  })
  it('a date-only string is that calendar day in the viewer zone, not the day before', () => {
    expect(formatMonthDay('2026-10-24')).toBe('October 24')
  })
  it('a Date or an ISO timestamp still works', () => {
    expect(formatMonthDay(new Date(2026, 9, 24, 12))).toBe('October 24')
    expect(formatTimeOfDay(new Date(2026, 9, 24, 15, 5))).toBe('3:05 PM')
    expect(formatTimeOfDay('2026-10-24T15:05:00')).toBe('3:05 PM')
    expect(formatMonthDay(new Date(NaN))).toBeNull()
  })
})

describe('filenameFromDisposition (round 27)', () => {
  const f = h => filenameFromDisposition({ 'content-disposition': h }, 'FALLBACK')
  it('an empty quoted name falls back instead of naming the file `""`', () => {
    expect(f('attachment; filename=""')).toBe('FALLBACK')
  })
  it('a cut-off quoted value is not trusted', () => {
    expect(f('attachment; filename="abc')).toBe('FALLBACK')
  })
  it('accepts a language tag in filename*', () => {
    expect(f("attachment; filename*=UTF-8'en'r%C3%A9sum%C3%A9.pdf")).toBe('résumé.pdf')
  })
  it('keeps the normal forms', () => {
    expect(f('attachment; filename="a b.pdf"')).toBe('a b.pdf')
    expect(f('attachment; filename=plain.pdf')).toBe('plain.pdf')
    expect(f("attachment; filename=\"a.pdf\"; filename*=UTF-8''b.pdf")).toBe('b.pdf')
    expect(f('attachment; filename="../x.pdf"')).toBe('FALLBACK')
  })
})

describe('previewOf keeps an emoji whole (round 27)', () => {
  it('does not cut a family emoji in half when no space falls inside the limit', () => {
    const family = '👨‍👩‍👧‍👦'
    const { shown, truncated } = previewOf(family.repeat(10), 15)   // 7 code points each: two fit, a third would be cut mid-emoji
    expect(truncated).toBe(true)
    expect(shown).toBe(family.repeat(2))
    expect(Array.from(shown).length).toBeLessThanOrEqual(15)
  })
  it('does not split a flag or a letter with its accent', () => {
    expect(previewOf('🇰🇪'.repeat(5), 5).shown).toBe('🇰🇪🇰🇪')
    const e = 'e\u0301'
    expect(previewOf(e.repeat(5), 5).shown).toBe(e + e)
  })
  it('still cuts plain text at a word boundary', () => {
    expect(previewOf('aaaa bbbb cccc', 9)).toEqual({ shown: 'aaaa bbbb', truncated: true })
    expect(previewOf('short', 10)).toEqual({ shown: 'short', truncated: false })
  })
})

describe('FileUpload card look: the held chip accepts a dropped replacement (round 27)', () => {
  const pdf = (name = 'new.pdf') => new File(['%PDF-1.4 hello'], name, { type: 'application/pdf' })
  it('replaces the file when one is dropped on the chip', async () => {
    const { default: FileUpload } = await import('../../src/components/ui/FileUpload')
    const onFile = vi.fn()
    const old = pdf('old.pdf')
    render(<FileUpload look="card" value={old} onFile={onFile} />)
    const chip = screen.getByTestId('file-chip')
    expect(chip).toHaveAttribute('data-file-dropzone')
    const fresh = pdf('new.pdf')
    act(() => {
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      ev.dataTransfer = { files: [fresh], types: ['Files'] }
      chip.dispatchEvent(ev)
    })
    expect(onFile).toHaveBeenCalledTimes(1)
    expect(onFile.mock.calls[0][0].name).toBe('new.pdf')
  })
  it('a disabled chip ignores a drop', async () => {
    const { default: FileUpload } = await import('../../src/components/ui/FileUpload')
    const onFile = vi.fn()
    render(<FileUpload look="card" value={pdf('old.pdf')} onFile={onFile} disabled />)
    const chip = screen.getByTestId('file-chip')
    act(() => {
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      ev.dataTransfer = { files: [pdf('x.pdf')], types: ['Files'] }
      chip.dispatchEvent(ev)
    })
    expect(onFile).not.toHaveBeenCalled()
  })
  it('an invalid file dropped on the chip keeps the old one and says why', async () => {
    const { default: FileUpload } = await import('../../src/components/ui/FileUpload')
    const onFile = vi.fn()
    render(<FileUpload look="card" value={pdf('old.pdf')} onFile={onFile} />)
    act(() => {
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      ev.dataTransfer = { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], types: ['Files'] }
      screen.getByTestId('file-chip').dispatchEvent(ev)
    })
    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/PDF|DOCX/i)
    expect(screen.getByTestId('file-chip')).toHaveTextContent('old.pdf')
  })
})
