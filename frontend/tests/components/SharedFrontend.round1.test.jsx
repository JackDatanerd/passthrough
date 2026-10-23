// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import Input from '../../src/components/ui/Input'
import Select from '../../src/components/ui/Select'
import Textarea from '../../src/components/ui/Textarea'
import Checkbox from '../../src/components/ui/Checkbox'
import FieldError from '../../src/components/ui/FieldError'
import Fieldset from '../../src/components/ui/Fieldset'
import RadioGroup from '../../src/components/ui/RadioGroup'
import Switch from '../../src/components/ui/Switch'
import { Tabs, TabPanel } from '../../src/components/ui/Tabs'
import Disclosure from '../../src/components/ui/Disclosure'
import UnsavedChangesPrompt from '../../src/components/layout/UnsavedChangesPrompt'
import { askDiscardUnsaved, markUnsaved, resetLeaveGuard, leaveAllowed } from '../../src/lib/unsavedGuard'
import { csvCell, withinHours, formatNumber } from '../../src/lib/utils'
import { useApi } from '../../src/hooks/useApi'

afterEach(() => { resetLeaveGuard(); vi.useRealTimers() })

describe('B4: an error always marks the control invalid and described', () => {
  it.each([
    ['Input', <Input label="a" error="bad" aria-invalid="false" aria-describedby="x" />],
    ['Select', <Select label="a" error="bad" aria-invalid="false" aria-describedby="x"><option>1</option></Select>],
    ['Textarea', <Textarea label="a" error="bad" aria-invalid="false" aria-describedby="x" />],
  ])('%s', (_n, el) => {
    render(el)
    const c = screen.getByLabelText('a')
    expect(c).toHaveAttribute('aria-invalid', 'true')
    expect(c.getAttribute('aria-describedby')).toContain('-error')
    expect(screen.getByRole('alert')).toHaveTextContent('bad')
  })
  it('Checkbox keeps the caller\'s describedby and adds the error', () => {
    render(<Checkbox label="c" error="bad" aria-invalid="false" aria-describedby="x" />)
    const c = screen.getByLabelText('c')
    expect(c).toHaveAttribute('aria-invalid', 'true')
    expect(c.getAttribute('aria-describedby')).toMatch(/x .+|.+ x/)
  })
})

describe('G2: FieldError / Fieldset / RadioGroup', () => {
  it('FieldError renders nothing when empty and an alert otherwise', () => {
    const { container, rerender } = render(<FieldError id="e">{''}</FieldError>)
    expect(container).toBeEmptyDOMElement()
    rerender(<FieldError id="e">Nope</FieldError>)
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'e')
  })
  it('Fieldset names the group and ties its error to it', () => {
    render(<Fieldset legend="Pick" error="Too many"><input type="checkbox" aria-label="x" /></Fieldset>)
    const g = screen.getByRole('group', { name: 'Pick' })
    expect(g.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })
  it('RadioGroup shares one name and reports the chosen value', () => {
    const onChange = vi.fn()
    render(<RadioGroup legend="V" name="g" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    expect(screen.getByLabelText('A')).toBeChecked()
    expect(screen.getByLabelText('B')).toHaveAttribute('name', 'g')
    fireEvent.click(screen.getByLabelText('B'))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('G2: Switch', () => {
  it('is a named switch that reports the NEW state and respects disabled', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Switch label="Mail me" checked={false} onChange={onChange} />)
    const s = screen.getByRole('switch', { name: 'Mail me' })
    expect(s).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(s)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<Switch label="Mail me" checked onChange={onChange} disabled />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('G2: Tabs', () => {
  function Harness() {
    const [v, setV] = useState('a')
    return (
      <>
        <Tabs idPrefix="t" ariaLabel="x" value={v} onChange={setV} tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]} />
        <TabPanel idPrefix="t" value={v}>panel-{v}</TabPanel>
      </>
    )
  }
  it('arrows wrap, Home/End jump, one tab stop, panel is labelled by its tab', () => {
    render(<Harness />)
    const tab = n => screen.getByRole('tab', { name: n })
    expect(tab('A')).toHaveAttribute('tabindex', '0')
    expect(tab('B')).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(tab('A'), { key: 'ArrowLeft' })
    expect(tab('C')).toHaveAttribute('aria-selected', 'true')
    expect(tab('C')).toHaveFocus()
    fireEvent.keyDown(tab('C'), { key: 'ArrowRight' })
    expect(tab('A')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(tab('A'), { key: 'End' })
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel-c')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 't-tab-c')
    fireEvent.keyDown(tab('C'), { key: 'Home' })
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel-a')
  })
})

describe('G2: Disclosure', () => {
  it('is a native details with a focus-visible ring on the summary and passes data-* through', () => {
    render(<Disclosure summary="More" data-testid="d">body</Disclosure>)
    expect(screen.getByTestId('d').tagName).toBe('DETAILS')
    expect(screen.getByText('More').className).toContain('focus-visible:ring-2')
  })
})

describe('G1: the unsaved-changes question is asked in the app dialog', () => {
  it('asks nothing when nothing is unsaved; shares one dialog; "Stay" resolves false; "Leave" opens the leave window', async () => {
    render(<UnsavedChangesPrompt />)
    expect(await askDiscardUnsaved('m')).toBe(true)
    const release = markUnsaved()
    let a, b
    act(() => { a = askDiscardUnsaved('Really?', { confirmLabel: 'Sign out' }); b = askDiscardUnsaved('Really?') })
    expect(await screen.findByText('Really?')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(await a).toBe(false); expect(await b).toBe(false)
    expect(leaveAllowed()).toBe(false)
    let c
    act(() => { c = askDiscardUnsaved('Again?') })
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }))
    expect(await c).toBe(true)
    expect(leaveAllowed()).toBe(true)
    release()
  })
  it('falls back to the native confirm with no host; force asks without a registered editor and does not open the window', async () => {
    const conf = vi.spyOn(window, 'confirm').mockReturnValue(true)
    expect(await askDiscardUnsaved('m', { force: true })).toBe(true)
    expect(conf).toHaveBeenCalledWith('m')
    expect(leaveAllowed()).toBe(false)
    conf.mockReturnValue(false)
    expect(await askDiscardUnsaved('m', { force: true })).toBe(false)
    conf.mockRestore()
  })
})

describe('B5/B6/G3: utils', () => {
  it('csvCell does not keep an over-long numeric-looking text as a formula-guarded cell', () => {
    expect(csvCell({ __csvText: '+1712345678' })).toBe('"=""+1712345678"""')
    const long = '1'.repeat(300)
    expect(csvCell({ __csvText: long })).toBe(long)
  })
  it('withinHours rejects a time far in the future but tolerates small clock skew', () => {
    const now = Date.now()
    expect(withinHours(new Date(now - 3600e3).toISOString(), 2)).toBe(true)
    expect(withinHours(new Date(now + 600e3).toISOString(), 2)).toBe(true)
    expect(withinHours(new Date(now + 5 * 3600e3).toISOString(), 2)).toBe(false)
  })
  it('formatNumber is en-US and dashes junk', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(null)).toBe('—')
  })
})

describe('B6: useApi refuses a new call after unmount', () => {
  it('rejects with an abort error unless keepAlive', async () => {
    const { result, unmount } = renderHook(() => useApi())
    unmount()
    const fn = vi.fn().mockResolvedValue({ data: 1 })
    await expect(result.current.execute(fn)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
    await expect(result.current.execute(fn, { keepAlive: true })).resolves.toBe(1)
  })
})
