// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Modal from '../../src/components/ui/Modal'

// Modal.jsx's own comments describe two bugs found by hand and fixed with
// module-level state: a scroll-lock counter (so a nested modal closing
// doesn't unlock background scroll while an outer one is still open) and a
// modal STACK (so Escape/Tab only ever act on the topmost dialog, not every
// open one at once). Both are exactly the kind of thing a future edit could
// silently break — this is the regression coverage for them (Section 12
// audit); there was none before.
afterEach(() => {
  document.body.style.overflow = ''
})

describe('Modal', () => {
  it('renders nothing when closed, and a labelled dialog when open', () => {
    const { rerender } = render(<Modal open={false} title="Hello" onClose={() => {}}>Body</Modal>)
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(<Modal open title="Hello" onClose={() => {}}>Body</Modal>)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(dialog).toHaveAccessibleName('Hello')
  })

  it('locks background scroll while open and restores it on close', () => {
    const { rerender, unmount } = render(<Modal open title="T" onClose={() => {}}>Body</Modal>)
    expect(document.body.style.overflow).toBe('hidden')
    rerender(<Modal open={false} title="T" onClose={() => {}}>Body</Modal>)
    expect(document.body.style.overflow).toBe('')
    unmount()
  })

  it('closing an outer modal while an inner one is still open does not unlock scroll', () => {
    const outer = render(<Modal open title="Outer" onClose={() => {}}>Outer body</Modal>)
    const inner = render(<Modal open title="Inner" onClose={() => {}}>Inner body</Modal>)
    expect(document.body.style.overflow).toBe('hidden')
    outer.unmount() // outer closes first; inner is still open
    expect(document.body.style.overflow).toBe('hidden') // must still be locked
    inner.unmount()
    expect(document.body.style.overflow).toBe('')
  })

  it('moves focus into the dialog on open and restores it to the trigger on close', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <Modal open={open} title="T" onClose={() => setOpen(false)}>
            <input placeholder="first field" />
          </Modal>
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByText('Open')
    await user.click(trigger)
    expect(screen.getByPlaceholderText('first field')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('Escape closes a dismissible modal but not a non-dismissible one', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { rerender } = render(<Modal open title="T" onClose={onClose} dismissible={false}>Body</Modal>)
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Close')).toBeNull() // no X button either while non-dismissible

    rerender(<Modal open title="T" onClose={onClose} dismissible>Body</Modal>)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking the backdrop closes a dismissible modal; the X button also closes it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { container } = render(<Modal open title="T" onClose={onClose}>Body</Modal>)
    await user.click(container.querySelector('.absolute.inset-0[aria-hidden="true"]'))
    expect(onClose).toHaveBeenCalledTimes(1)

    onClose.mockClear()
    await user.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // The core module-level fix this file describes: two Modals mounted at
  // once (nested), only the top one should react to Escape.
  it('only the topmost of two open modals responds to Escape', async () => {
    const user = userEvent.setup()
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(<Modal open title="Outer" onClose={onCloseOuter}>Outer</Modal>)
    render(<Modal open title="Inner" onClose={onCloseInner}>Inner</Modal>)

    await user.keyboard('{Escape}')
    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('Tab wraps focus from the last focusable element back to the first', async () => {
    const user = userEvent.setup()
    render(
      <Modal open title="T" onClose={() => {}}>
        <input placeholder="one" />
        <input placeholder="two" />
      </Modal>
    )
    const first = screen.getByPlaceholderText('one')
    const last = screen.getByPlaceholderText('two')
    last.focus()
    await user.tab()
    expect(first).toHaveFocus()
    await user.tab({ shift: true })
    expect(last).toHaveFocus()
  })
})
