// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import Checkbox from '../../src/components/ui/Checkbox'
import Select from '../../src/components/ui/Select'
import Input from '../../src/components/ui/Input'
import Textarea from '../../src/components/ui/Textarea'
import Menu from '../../src/components/ui/Menu'
import { ToastProvider, useToast } from '../../src/components/ui/Toast'
import { formatMonthDay, formatTimeOfDay, csvCell } from '../../src/lib/utils'

describe('pending keeps focus (round 26)', () => {
  it('Checkbox: stays focused, aria-disabled, ignores toggles', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Checkbox label="Email me" checked={false} pending onChange={onChange} />)
    const box = screen.getByRole('checkbox')
    box.focus()
    await user.click(box)
    expect(box).toHaveFocus()
    expect(box).toHaveAttribute('aria-disabled', 'true')
    expect(box).not.toBeDisabled()
    expect(box).not.toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('Checkbox: still toggles when not pending', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    function Host() { const [on, setOn] = useState(false); return <Checkbox label="x" checked={on} onChange={e => { onChange(); setOn(e.target.checked) }} /> }
    render(<Host />)
    await user.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })
  it('Select: pending ignores changes and is not natively disabled', async () => {
    const onChange = vi.fn()
    render(<Select aria-label="Status" value="A" pending onChange={onChange}><option value="A">A</option><option value="B">B</option></Select>)
    const sel = screen.getByRole('combobox')
    sel.focus()
    await userEvent.setup().selectOptions(sel, 'B')
    expect(onChange).not.toHaveBeenCalled()
    expect(sel).toHaveAttribute('aria-disabled', 'true')
    expect(sel).not.toBeDisabled()
    expect(sel).toHaveFocus()
  })
  it('Input and Textarea: pending is read-only + aria-disabled, not disabled', () => {
    render(<><Input label="a" pending defaultValue="x" /><Textarea label="b" pending defaultValue="y" /></>)
    for (const el of [screen.getByLabelText('a'), screen.getByLabelText('b')]) {
      expect(el).toHaveAttribute('readonly')
      expect(el).toHaveAttribute('aria-disabled', 'true')
      expect(el).not.toBeDisabled()
    }
  })
})

describe('Menu ArrowUp from a non-item (round 26)', () => {
  it('goes to the last item', async () => {
    const user = userEvent.setup()
    render(<Menu label="Actions"><button role="menuitem">One</button><button role="menuitem">Two</button><button role="menuitem">Three</button></Menu>)
    await user.click(screen.getByRole('button', { name: 'Actions' }))
    const menu = screen.getByRole('menu')
    menu.tabIndex = -1; menu.focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitem', { name: 'Three' })).toHaveFocus()
  })
})

describe('toast with a plain string (round 26)', () => {
  it('shows the message', () => {
    let t
    function Grab() { t = useToast(); return null }
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { t('Saved') })
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })
})

describe('shared en-US formatters and csv (round 26)', () => {
  it('formats month/day and time in en-US, null when invalid', () => {
    expect(formatMonthDay(new Date(2026, 10, 14))).toBe('November 14')
    expect(formatTimeOfDay(new Date(2026, 10, 14, 15, 0))).toMatch(/^3:00\s?PM$/)
    expect(formatMonthDay('nope')).toBeNull()
    expect(formatTimeOfDay(undefined)).toBeNull()
  })
  it('csv treats -.5 as a number', () => { expect(csvCell('-.5')).toBe('-.5'); expect(csvCell('-.5+1')).toBe("'-.5+1") })
})
