// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link, Routes, Route, useLocation } from 'react-router-dom'
import Menu from '../src/components/ui/Menu'
import { formatDate, formatDateTime, formatDateUtc } from '../src/lib/utils'

// Shared frontend, section 11 round 19.
describe('formatDate: an impossible calendar day is unknown, not another date', () => {
  it('refuses a day that does not exist and a month past December', () => {
    expect(formatDate('2026-02-30')).toBe('—')
    expect(formatDate('2026-13-01')).toBe('—')
    expect(formatDate('2026-04-31')).toBe('—')
    expect(formatDate('2025-02-29')).toBe('—')
    expect(formatDateUtc('2026-02-30')).toBe('—')
    expect(formatDateTime('2026-02-30')).toBe('—')
  })
  it('still formats real date-only values, including a leap day', () => {
    expect(formatDate('2026-09-01')).toBe('Sep 1, 2026')
    expect(formatDate('2028-02-29')).toBe('Feb 29, 2028')
    expect(formatDateUtc('2026-12-31')).toBe('Dec 31, 2026')
    expect(formatDateTime('2026-09-01')).toBe('Sep 1, 2026')
  })
  it('leaves timestamps alone', () => {
    expect(formatDate('2026-10-15T12:00:00Z')).toBe('Oct 15, 2026')
  })
})

function Where() { return <span data-testid="where">{useLocation().pathname}</span> }
function Demo({ onPick = () => {} }) {
  return (
    <MemoryRouter initialEntries={['/start']}>
      <Where />
      <Menu label="More actions">
        <button type="button" role="menuitem" onClick={() => onPick('b')}>See the breakdown</button>
        <Link role="menuitem" to="/rescan">Scan against another job</Link>
        <span role="menuitem" tabIndex={-1} onClick={() => onPick('span')}>Plain element</span>
      </Menu>
    </MemoryRouter>
  )
}
const trigger = () => screen.getByRole('button', { name: 'More actions' })

describe('Menu: Enter and Space activate every kind of item', () => {
  it('Space on a router Link item follows it and closes the menu', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Scan against another job' }))
    await userEvent.keyboard(' ')
    expect(screen.getByTestId('where').textContent).toBe('/rescan')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
  it('Enter on a Link still works exactly once', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByTestId('where').textContent).toBe('/rescan')
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('Enter and Space on a non-native item click it; a button is left to the browser (one call, not two)', async () => {
    const onPick = vi.fn()
    render(<Demo onPick={onPick} />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{End}{Enter}')
    expect(onPick).toHaveBeenLastCalledWith('span')
    await userEvent.click(trigger())
    await userEvent.keyboard('{Home}{Enter}')
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(onPick).toHaveBeenLastCalledWith('b')
  })
})

describe('Menu: Escape and Tab from the trigger while the menu is open', () => {
  it('Escape closes it and keeps focus on the trigger', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    trigger().focus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
  it('Tab closes it instead of leaving it hanging open', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    trigger().focus()
    await userEvent.keyboard('{Tab}')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
