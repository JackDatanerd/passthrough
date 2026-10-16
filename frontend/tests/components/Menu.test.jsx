// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Menu from '../../src/components/ui/Menu'

function Demo({ onPick = () => {}, extra }) {
  return (
    <div>
      <button>before</button>
      <Menu label="More actions">
        <button type="button" role="menuitem" onClick={() => onPick('breakdown')}>See the breakdown</button>
        <button type="button" role="menuitem" disabled onClick={() => onPick('disabled')}>Archive</button>
        <button type="button" role="menuitem" onClick={() => onPick('delete')}>Delete…</button>
        {extra}
      </Menu>
      <button>after</button>
    </div>
  )
}
const trigger = () => screen.getByRole('button', { name: 'More actions' })
const items = () => screen.getAllByRole('menuitem')

describe('Menu', () => {
  it('is closed by default and the trigger advertises a menu', () => {
    render(<Demo />)
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('click opens it and puts focus on the first item; the items leave the Tab order', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(trigger().getAttribute('aria-controls')).toBe(screen.getByRole('menu').id)
    expect(document.activeElement).toBe(items()[0])
    expect(items().every(i => i.getAttribute('tabindex') === '-1')).toBe(true)
  })

  it('ArrowDown on the trigger opens with the first item focused; ArrowUp with the last', async () => {
    const { unmount } = render(<Demo />)
    trigger().focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(items()[0])
    unmount()
    render(<Demo />)
    trigger().focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(items()[items().length - 1])
  })

  it('arrows move between items, wrap, skip a disabled one, and Home / End jump', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    const [a, , c] = items()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(c)            // "Archive" is disabled
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(a)            // wraps
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(c)
    await userEvent.keyboard('{Home}')
    expect(document.activeElement).toBe(a)
    await userEvent.keyboard('{End}')
    expect(document.activeElement).toBe(c)
  })

  it('a letter jumps to the next item that starts with it', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.keyboard('d')
    expect(document.activeElement.textContent).toBe('Delete…')
  })

  it('Escape closes it and returns focus to the trigger', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('Tab closes it and carries on from the trigger (not from <body>)', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.tab()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }))
  })

  it('Shift+Tab closes it and goes to the control before the trigger', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    await userEvent.tab({ shift: true })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'before' }))
  })

  it('a press outside closes it', async () => {
    render(<Demo />)
    await userEvent.click(trigger())
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('choosing an item runs it, closes the menu, and focus is already back on the trigger when the item runs', async () => {
    const seen = []
    render(<Demo onPick={() => seen.push(document.activeElement)} />)
    await userEvent.click(trigger())
    await userEvent.click(items()[0])
    expect(seen).toEqual([trigger()])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Enter on a focused item activates it', async () => {
    const onPick = vi.fn()
    render(<Demo onPick={onPick} />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith('breakdown')
  })

  it('a parent re-render while open does not pull focus back to the first item', async () => {
    function Host() {
      const [n, setN] = useState(0)
      return <div><button onClick={() => setN(n + 1)}>tick {n}</button><Menu label="More actions"><button type="button" role="menuitem">One</button><button type="button" role="menuitem">Two</button></Menu></div>
    }
    render(<Host />)
    await userEvent.click(trigger())
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement.textContent).toBe('Two')
    fireEvent.click(screen.getByRole('button', { name: /tick/ }))   // no focus change from a programmatic click
    screen.getAllByRole('menuitem')[1].focus()
    expect(document.activeElement.textContent).toBe('Two')
  })
})
