// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PasswordInput from '../../src/components/ui/PasswordInput'
import Input from '../../src/components/ui/Input'

describe('PasswordInput', () => {
  it('starts hidden and toggles to visible text and back', async () => {
    const u = userEvent.setup()
    render(<PasswordInput label="Password" defaultValue="hunter2-hunter2" />)
    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('type', 'password')
    const toggle = screen.getByRole('button', { name: 'Show password' })
    // The label itself flips (Show/Hide), so aria-pressed on top would announce the state twice.
    expect(toggle).not.toHaveAttribute('aria-pressed')
    await u.click(toggle)
    expect(field).toHaveAttribute('type', 'text')
    expect(field).toHaveAttribute('autocapitalize', 'none')
    expect(screen.getByRole('button', { name: 'Hide password' })).not.toHaveAttribute('aria-pressed')
    await u.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(field).toHaveAttribute('type', 'password')
  })

  it('the toggle is not a submit button (it must not submit the surrounding form)', () => {
    render(<PasswordInput label="Password" />)
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('type', 'button')
  })

  it('keeps passing through autoComplete, placeholder and onChange', async () => {
    const u = userEvent.setup()
    let seen = ''
    render(<PasswordInput label="Password" autoComplete="new-password" placeholder="Min. 8 characters" onChange={e => { seen = e.target.value }} />)
    const field = screen.getByLabelText('Password')
    expect(field).toHaveAttribute('autocomplete', 'new-password')
    expect(field).toHaveAttribute('placeholder', 'Min. 8 characters')
    await u.type(field, 'abc')
    expect(seen).toBe('abc')
  })

  it('an unlabeled one still has an accessible name (placeholder) alongside its toggle', () => {
    render(<PasswordInput placeholder="Your password" />)
    expect(screen.getByLabelText('Your password')).toBeInTheDocument()
  })

  it('plain Input without an adornment renders exactly as before (no wrapper)', () => {
    const { container } = render(<Input label="Email" />)
    expect(container.querySelector('.relative')).toBeNull()
  })
})
