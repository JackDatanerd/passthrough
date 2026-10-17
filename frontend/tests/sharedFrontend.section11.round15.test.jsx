// @vitest-environment jsdom
// Section 11, round 15 — Tabs keys/tab stop, FileUpload disabled drag, Menu viewport clamp, PasswordInput names, useApi replace scope.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react'
import { Tabs } from '../src/components/ui/Tabs'
import FileUpload from '../src/components/ui/FileUpload'
import Menu from '../src/components/ui/Menu'
import PasswordInput from '../src/components/ui/PasswordInput'
import { useApi } from '../src/hooks/useApi'

const TABS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C', disabled: true }]
const strip = (value, onChange = () => {}) => render(<Tabs idPrefix="t" ariaLabel="x" tabs={TABS} value={value} onChange={onChange} />)

describe('B1 — Tabs leave browser/OS arrow shortcuts alone', () => {
  it.each([['altKey'], ['metaKey'], ['ctrlKey']])('%s + ArrowLeft is not swallowed', mod => {
    const onChange = vi.fn()
    strip('a', onChange)
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true, [mod]: true })
    screen.getByRole('tab', { name: 'A' }).dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('a bare arrow still moves and selects', () => {
    const onChange = vi.fn()
    strip('a', onChange)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('B2 — Tabs always have one tab stop', () => {
  it('falls back to the first enabled tab when value matches nothing', () => {
    strip(undefined)
    expect(screen.getByRole('tab', { name: 'A' })).toHaveProperty('tabIndex', 0)
    expect(screen.getByRole('tab', { name: 'B' })).toHaveProperty('tabIndex', -1)
  })
  it('falls back when value is a disabled tab', () => {
    strip('c')
    expect(screen.getByRole('tab', { name: 'A' })).toHaveProperty('tabIndex', 0)
  })
  it('the selected tab stays the stop', () => {
    strip('b')
    expect(screen.getByRole('tab', { name: 'B' })).toHaveProperty('tabIndex', 0)
    expect(screen.getByRole('tab', { name: 'A' })).toHaveProperty('tabIndex', -1)
  })
})

describe('B3 — disabled FileUpload is not a drop target', () => {
  it('dragover sets dropEffect none when disabled, not otherwise', () => {
    const { container, rerender } = render(<FileUpload onFile={() => {}} disabled />)
    const zone = container.querySelector('[data-file-dropzone]')
    const dt = { types: ['Files'], dropEffect: 'copy' }
    fireEvent.dragOver(zone, { dataTransfer: dt })
    expect(dt.dropEffect).toBe('none')
    rerender(<FileUpload onFile={() => {}} />)
    const dt2 = { types: ['Files'], dropEffect: 'copy' }
    fireEvent.dragOver(container.querySelector('[data-file-dropzone]'), { dataTransfer: dt2 })
    expect(dt2.dropEffect).toBe('copy')
  })
})

describe('B4 — Menu stays inside the viewport horizontally', () => {
  function open(rectRight, rectLeft, width, align) {
    document.documentElement.style.width = '400px'
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 400 })
    const proto = HTMLElement.prototype
    const w = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return this.getAttribute('role') === 'menu' ? width : 0 } })
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 30, left: rectLeft, right: rectRight, width: rectRight - rectLeft, height: 20 })
    render(<Menu label="m" align={align}><button role="menuitem">x</button></Menu>)
    fireEvent.click(screen.getByLabelText('m', { selector: 'button' }))
    const menu = screen.getByRole('menu')
    rect.mockRestore()
    if (w) Object.defineProperty(proto, 'offsetWidth', w); else delete proto.offsetWidth
    return parseFloat(menu.style.left)
  }
  it('right-aligned menu from a trigger near the left edge does not go negative', () => {
    const left = open(40, 10, 224, 'right')
    expect(left).toBeGreaterThanOrEqual(8)
  })
  it('left-aligned menu from a trigger near the right edge does not overflow', () => {
    const left = open(390, 350, 224, 'left')
    expect(left + 224).toBeLessThanOrEqual(400 - 8 + 0.001)
  })
})

describe('B5 — PasswordInput toggles name their field', () => {
  it('default label keeps the plain name; a specific label is added', () => {
    render(<><PasswordInput label="Password" /><PasswordInput label="Confirm password" /></>)
    expect(screen.getByRole('button', { name: 'Show password' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show password: Confirm password' })).toBeTruthy()
  })
})

describe('L2 — useApi refuses a superseded result', () => {
  it('a superseded replace call that ignored the signal is refused, not applied', async () => {
    const { result } = renderHook(() => useApi())
    let slow
    const slowP = new Promise(r => { slow = r })
    let first
    await act(async () => { first = result.current.execute(() => slowP.then(() => ({ data: 'old' })), { replace: true }).catch(e => e) })
    await act(async () => { await result.current.execute(() => Promise.resolve({ data: 'new' }), { replace: true }) })
    slow(); const out = await act(async () => first)
    expect(out.name).toBe('AbortError')
    expect(result.current.error).toBe(null)
  })
})
