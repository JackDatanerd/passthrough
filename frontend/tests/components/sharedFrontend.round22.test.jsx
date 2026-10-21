// @vitest-environment jsdom
// Shared frontend round 22: the Modal focus trap ignores tabindex="-1" stops; formatDateTime takes a Date; copyToClipboard refuses empty text.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import Modal from '../../src/components/ui/Modal'
import { Tabs } from '../../src/components/ui/Tabs'
import { formatDateTime, copyToClipboard } from '../../src/lib/utils'

afterEach(cleanup)
const tab = shift => { const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented }

describe('Modal focus trap vs tabindex="-1"', () => {
  it('Shift+Tab from the first real field wraps to the last button (hidden tabindex=-1 input is not a stop)', () => {
    render(
      <Modal open onClose={() => {}} title="Session ended" dismissible={false}>
        <input type="email" readOnly tabIndex={-1} aria-hidden="true" data-testid="ghost" />
        <input data-testid="pw" data-autofocus />
        <button>Discard</button><button>Continue</button>
      </Modal>)
    expect(document.activeElement).toBe(screen.getByTestId('pw'))
    expect(tab(true)).toBe(true)
    expect(document.activeElement).toBe(screen.getByText('Continue'))
  })
  it('Tab from the last button wraps to the first real field, never onto the hidden input', () => {
    render(
      <Modal open onClose={() => {}} title="T" dismissible={false}>
        <input readOnly tabIndex={-1} data-testid="ghost" />
        <input data-testid="pw" data-autofocus />
        <button>Continue</button>
      </Modal>)
    screen.getByText('Continue').focus()
    expect(tab(false)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('pw'))
  })
  it('inactive tabs (tabindex=-1) are not the trap edge', () => {
    render(
      <Modal open onClose={() => {}} title="T" dismissible={false}>
        <input data-testid="a" data-autofocus />
        <Tabs idPrefix="x" ariaLabel="t" tabs={[{ id: '1', label: 'One' }, { id: '2', label: 'Two' }]} value="1" onChange={() => {}} />
      </Modal>)
    screen.getByText('One').focus()
    expect(tab(false)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('a'))
  })
  it('initial focus skips a tabindex=-1 input', () => {
    render(<Modal open onClose={() => {}} title="T" dismissible={false}><input readOnly tabIndex={-1} /><input data-testid="real" /></Modal>)
    expect(document.activeElement).toBe(screen.getByTestId('real'))
  })
})

describe('utils round 22', () => {
  it('formatDateTime accepts a Date and still rejects an invalid one', () => {
    expect(formatDateTime(new Date(2026, 9, 21, 14, 5))).toMatch(/Oct 21, 2026/)
    expect(formatDateTime(new Date('nope'))).toBe('—')
  })
  it('copyToClipboard does not copy "undefined"', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    expect(await copyToClipboard(undefined)).toBe(false)
    expect(await copyToClipboard(null)).toBe(false)
    expect(await copyToClipboard('')).toBe(false)
    expect(await copyToClipboard({})).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(await copyToClipboard('abc')).toBe(true)
    expect(await copyToClipboard(42)).toBe(true)
    expect(writeText).toHaveBeenLastCalledWith('42')
  })
})

import { useState } from 'react'
import { fireEvent } from '@testing-library/react'
import { ReferralCodeEntry } from '../../src/components/ui/ReferralCodeEntry'

describe('ReferralCodeEntry collapsible (checkout offer)', () => {
  function Host({ start = '' }) {
    const [code, setCode] = useState(start)
    return <ReferralCodeEntry collapsible referralCode={code} pricing={code ? { referralApplied: true, discountApplied: true } : null} onApply={setCode} disabled={false} />
  }
  it('starts as a quiet link and "Have a code?" opens the field with focus on it', () => {
    render(<Host />)
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByText('Have a code?'))
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })
  it('removing an applied code returns to the open field with focus, not to the link with focus on <body>', () => {
    render(<Host start="COACH20" />)
    fireEvent.click(screen.getByText('remove'))
    expect(screen.queryByText('Have a code?')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })
})
