// @vitest-environment jsdom
import { createRef } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Input from '../../src/components/ui/Input'
import Textarea from '../../src/components/ui/Textarea'
import Select from '../../src/components/ui/Select'

// Input.jsx's own comment lists what changed and why: ids from useId()
// instead of derived from label text (two same-labelled fields used to share
// an id — label clicks focused the wrong field, and a non-string label
// crashed the render outright), forwardRef so a parent can focus the first
// invalid field, and error/hint wired to aria-invalid/aria-describedby.
// Textarea.jsx and Select.jsx both say "see Input.jsx for what changed and
// why" — they're meant to share this exact contract, so one parametrized
// suite is the right shape for testing it (Section 12 audit): it fails the
// same way for whichever of the three drifts from the other two.
const fields = [
  { name: 'Input', Component: Input, tag: 'input' },
  { name: 'Textarea', Component: Textarea, tag: 'textarea' },
  { name: 'Select', Component: Select, tag: 'select', children: <option value="a">A</option> },
]

describe.each(fields)('$name (shared field contract)', ({ Component, tag, children }) => {
  it('auto-generates a unique id per instance via useId, with the label linked to it', () => {
    const { container } = render(
      <>
        <Component label="Email" data-testid="one">{children}</Component>
        <Component label="Email" data-testid="two">{children}</Component>
      </>
    )
    const [first, second] = container.querySelectorAll(tag)
    expect(first.id).toBeTruthy()
    expect(first.id).not.toBe(second.id) // two same-labelled fields must not collide
    const labels = screen.getAllByText('Email')
    expect(labels[0]).toHaveAttribute('for', first.id)
    expect(labels[1]).toHaveAttribute('for', second.id)
  })

  it('respects an explicit id instead of generating one', () => {
    const { container } = render(<Component id="explicit-id" label="X">{children}</Component>)
    expect(container.querySelector(tag).id).toBe('explicit-id')
  })

  it('wires an error to aria-invalid and an announced, linked error message', () => {
    render(<Component label="X" error="Required" data-testid="f">{children}</Component>)
    const field = screen.getByRole(tag === 'input' ? 'textbox' : tag === 'textarea' ? 'textbox' : 'combobox')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    const errorMsg = screen.getByRole('alert')
    expect(errorMsg).toHaveTextContent('Required')
    expect(field.getAttribute('aria-describedby')).toContain(errorMsg.id)
  })

  it('wires a hint (with no error) to aria-describedby, and hides the hint once there is an error', () => {
    const { rerender } = render(<Component label="X" hint="Helpful">{children}</Component>)
    const field = screen.getByRole(tag === 'input' ? 'textbox' : tag === 'textarea' ? 'textbox' : 'combobox')
    expect(screen.getByText('Helpful')).toBeInTheDocument()
    expect(field.getAttribute('aria-describedby')).toContain(screen.getByText('Helpful').id)

    rerender(<Component label="X" hint="Helpful" error="Bad">{children}</Component>)
    expect(screen.queryByText('Helpful')).toBeNull() // error takes over, per the `hint && !error` guard
    expect(screen.getByRole('alert')).toHaveTextContent('Bad')
    // BUG FIX (Section 11 audit): aria-describedby used to still list the
    // hint's id here even though its <p> no longer renders — a dangling
    // reference. It must now list ONLY the error's id.
    const describedBy = field.getAttribute('aria-describedby')
    expect(describedBy).toBe(screen.getByRole('alert').id)
  })

  it('forwards a ref to the underlying element', () => {
    const ref = createRef()
    render(<Component label="X" ref={ref}>{children}</Component>)
    expect(ref.current).toBeInstanceOf(HTMLElement)
    expect(ref.current.tagName.toLowerCase()).toBe(tag)
  })
})

// Input/Textarea-only: the placeholder → aria-label fallback for unlabeled
// fields. Select has no `placeholder` concept, so this doesn't apply to it.
describe.each([
  { name: 'Input', Component: Input },
  { name: 'Textarea', Component: Textarea },
])('$name placeholder fallback', ({ Component }) => {
  it('falls back to aria-label = placeholder when there is no visible label', () => {
    render(<Component placeholder="Search leads…" />)
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Search leads…')
  })

  it('an explicit aria-label always wins over the placeholder fallback', () => {
    render(<Component placeholder="Search leads…" aria-label="Lead search" />)
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-label', 'Lead search')
  })

  it('a visible label means no aria-label fallback is needed', () => {
    render(<Component label="Search" placeholder="Search leads…" />)
    expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-label')
  })
})
