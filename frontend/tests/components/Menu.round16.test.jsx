// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Menu from '../../src/components/ui/Menu'

// Round 16 (B1): opening the menu moves focus to an item BEFORE the layout effect has repositioned the list. A plain focus()
// scrolls the page to reveal that item when the trigger is near the viewport's bottom edge, and Menu closes on any scroll that
// starts outside the list — so the menu shut itself the moment it opened. jsdom cannot scroll, so this pins the cause: the
// focus call must not ask the browser to scroll.
describe('Menu — opening focus does not scroll the page', () => {
  afterEach(() => vi.restoreAllMocks())

  const Demo = () => (
    <Menu label="More actions">
      <button type="button" role="menuitem">One</button>
      <button type="button" role="menuitem">Two</button>
    </Menu>
  )
  function spyFocus() {
    const calls = []
    const orig = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (opts) {
      if (this.getAttribute?.('role') === 'menuitem') calls.push({ text: this.textContent, opts })
      return orig.call(this, opts)
    })
    return calls
  }

  it('click-open focuses the first item with preventScroll', async () => {
    const calls = spyFocus()
    render(<Demo />)
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]).toEqual({ text: 'One', opts: { preventScroll: true } })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('ArrowUp-open focuses the last item with preventScroll', async () => {
    const calls = spyFocus()
    render(<Demo />)
    screen.getByRole('button', { name: 'More actions' }).focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(calls[0]).toEqual({ text: 'Two', opts: { preventScroll: true } })
  })

  it('a scroll that starts outside the list still closes an open menu (unchanged)', async () => {
    render(<Demo />)
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    document.dispatchEvent(new Event('scroll'))
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})
