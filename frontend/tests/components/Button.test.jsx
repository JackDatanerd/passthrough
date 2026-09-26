// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Button from '../../src/components/ui/Button'

describe('Button', () => {
  it('calls onClick when enabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('disabled prevents onClick and sets the disabled attribute', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick} disabled>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeDisabled()
    await user.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('loading also disables the button and marks it aria-busy, even without an explicit disabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Button onClick={onClick} loading>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    await user.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('defaults to type="button" so it never accidentally submits a form', () => {
    render(<Button>Click</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })

  it('type="submit" is respected when explicitly set', () => {
    render(<Button type="submit">Save</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it.each([
    ['primary', 'bg-blue-700'],
    ['secondary', 'bg-white'],
    ['danger', 'bg-red-600'],
    ['ghost', 'bg-transparent'],
  ])('variant=%s applies its color classes', (variant, expectedClass) => {
    render(<Button variant={variant}>X</Button>)
    expect(screen.getByRole('button').className).toContain(expectedClass)
  })
})
