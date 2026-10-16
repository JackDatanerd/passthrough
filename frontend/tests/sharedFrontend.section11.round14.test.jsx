// @vitest-environment jsdom
// Section 11, round 14 — G1/G2 and B1–B4 (+ latent L1–L4) from the independent audit.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import Textarea from '../src/components/ui/Textarea'
import Input from '../src/components/ui/Input'
import FileUpload from '../src/components/ui/FileUpload'
import Alert from '../src/components/ui/Alert'
import Checkbox from '../src/components/ui/Checkbox'
import Menu from '../src/components/ui/Menu'
import { filenameFromDisposition } from '../src/lib/utils'

const paste = (el, text) => fireEvent.paste(el, { clipboardData: { getData: () => text } })

describe('B1 — paste counter normalises CRLF', () => {
  it('a CRLF paste that fits exactly is not reported as cut', () => {
    render(<Textarea aria-label="t" showCount maxLength={5} />)
    paste(screen.getByLabelText('t'), 'ab\r\ncd')
    expect(screen.getByRole('status').textContent).not.toMatch(/cut/)
  })
  it('a real cut is counted with line breaks as one character', () => {
    render(<Textarea aria-label="t" showCount maxLength={4} />)
    paste(screen.getByLabelText('t'), 'ab\r\ncd')   // 5 chars once normalised -> 1 over
    expect(screen.getByRole('status').textContent).toMatch(/cut by 1 character /)
  })
  it('single-line input still drops line breaks entirely', () => {
    render(<Input aria-label="i" showCount maxLength={4} />)
    paste(screen.getByLabelText('i'), 'ab\r\ncd')   // 4 chars once breaks are dropped -> fits
    expect(screen.getByRole('status').textContent).not.toMatch(/cut/)
  })
})

describe('B3 — filenameFromDisposition', () => {
  it('malformed filename* falls back to the plain filename', () => {
    const h = new Headers({ 'content-disposition': "attachment; filename=\"ok.pdf\"; filename*=UTF-8''%E0%A4%A" })
    expect(filenameFromDisposition(h, 'fb')).toBe('ok.pdf')
  })
  it('malformed filename* alone still falls back', () => {
    expect(filenameFromDisposition(new Headers({ 'content-disposition': "attachment; filename*=UTF-8''%E0%A4%A" }), 'fb')).toBe('fb')
  })
  it('valid filename* still wins', () => {
    expect(filenameFromDisposition(new Headers({ 'content-disposition': "attachment; filename=\"a.pdf\"; filename*=UTF-8''%C3%A9.pdf" }), 'fb')).toBe('é.pdf')
  })
})

describe('G2/B2 — FileUpload announces and keeps focus', () => {
  const live = () => document.querySelector('[data-announcer]')?.textContent || ''
  it('announces a selection and a removal, and focus lands on the dropzone', async () => {
    function Harness() {
      const [f, setF] = React.useState(null)
      return <FileUpload value={f} onFile={setF} />
    }
    const { container } = render(<Harness />)
    const input = container.querySelector('input[type=file]')
    const file = new File(['%PDF-1.4 x'], 'cv.pdf', { type: 'application/pdf' })
    fireEvent.change(input, { target: { files: [file] } })
    await new Promise(r => setTimeout(r, 120))
    expect(live()).toMatch(/Selected cv\.pdf/)
    const remove = screen.getByText('Remove file'); remove.focus(); fireEvent.click(remove)
    expect(document.activeElement).toBe(container.querySelector('[data-file-dropzone]'))
    await new Promise(r => setTimeout(r, 120))
    expect(live()).toMatch(/File removed/)
  })
})

describe('L3 — Alert with only-empty children renders nothing', () => {
  it('two falsy children', () => {
    const { container } = render(<Alert>{false}{null}</Alert>)
    expect(container.firstChild).toBeNull()
  })
  it('real content still renders', () => {
    render(<Alert>{false}Boom</Alert>)
    expect(screen.getByRole('alert').textContent).toBe('Boom')
  })
})

describe('L4 — Checkbox indeterminate survives a click while the prop stays true', () => {
  it('re-asserted after the click', () => {
    function H() { const [c, setC] = React.useState(false); return <Checkbox label="all" indeterminate checked={c} onChange={e => setC(e.target.checked)} /> }
    render(<H />)
    const box = screen.getByLabelText('all')
    expect(box.indeterminate).toBe(true)
    fireEvent.click(box)
    expect(box.indeterminate).toBe(true)
  })
})

describe('L1/L2 — Menu', () => {
  it('opens fixed to the viewport (not clipped by a scrolling parent) and clicking a disabled item keeps it open', () => {
    render(
      <div style={{ overflowX: 'auto' }}>
        <Menu label="Row actions">
          <button role="menuitem" onClick={() => {}}>Edit</button>
          <button role="menuitem" aria-disabled="true">Nope</button>
        </Menu>
      </div>
    )
    fireEvent.click(screen.getByLabelText('Row actions'))
    const menu = screen.getByRole('menu')
    expect(menu.style.position).toBe('fixed')
    fireEvent.click(screen.getByText('Nope'))
    expect(screen.queryByRole('menu')).not.toBeNull()
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('closes when the page scrolls', () => {
    render(<Menu label="m"><button role="menuitem">A</button></Menu>)
    fireEvent.click(screen.getByLabelText('m'))
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('B4 — Navbar aria-controls only while open', () => {
  it('both toggles gate aria-controls on their open state', () => {
    const src = readFileSync('frontend/src/components/layout/Navbar.jsx', 'utf8')
    expect(src).toMatch(/aria-controls=\{menuOpen \? 'navbar-more' : undefined\}/)
    expect(src).toMatch(/aria-controls=\{storiesOpen \? 'navbar-stories' : undefined\}/)
  })
})

describe('G1 — ScanForm uses the shared Checkbox', () => {
  it('no raw checkbox left in ScanForm', () => {
    const src = readFileSync('frontend/src/components/scan/ScanForm.jsx', 'utf8')
    expect(src).not.toMatch(/<input[^>]*type="checkbox"/)
    expect(src).toMatch(/data-testid="rescan-use-improved"/)
  })
})
