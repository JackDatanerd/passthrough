// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Form from '../../src/components/ui/Form'

// Form.jsx's own comment: the app had no real <form> elements before this —
// every submit was a plain onClick, so Enter-to-submit, mobile keyboards'
// "Go" key, and native email validation never worked. This just checks the
// wrapper actually does what it exists to do: a real <form>, submits via
// Enter, preventDefault so the page never reloads, and noValidate so the
// page's own error messages stay in charge (Section 12 audit).
describe('Form', () => {
  it('renders a real <form> element with noValidate', () => {
    const { container } = render(<Form onSubmit={() => {}}>content</Form>)
    const form = container.querySelector('form')
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute('noValidate')
  })

  it('calls onSubmit and prevents the default page reload when the submit button is clicked', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <Form onSubmit={onSubmit}>
        <button type="submit">Save</button>
      </Form>
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    // jsdom throws "Not implemented: HTMLFormElement.prototype.submit" if the
    // real submit ever goes through unprevented — reaching this line at all
    // (no unhandled jsdom error) is itself part of what's being checked.
  })

  it('submits on Enter inside a text field, not just on a button click', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(
      <Form onSubmit={onSubmit}>
        <input type="text" aria-label="Email" />
        <button type="submit">Save</button>
      </Form>
    )
    await user.type(screen.getByLabelText('Email'), 'a@b.com{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
