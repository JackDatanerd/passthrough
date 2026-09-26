// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmDialog from '../../src/components/ui/ConfirmDialog'

// ConfirmDialog.jsx's whole reason for existing (per its own comment) is
// replacing window.confirm() with something that's actually testable and
// that correctly blocks dismissal while a confirm action is in flight — so
// that's exactly what this covers (Section 12 audit).
describe('ConfirmDialog', () => {
  it('renders nothing when closed, and the message/buttons when open', () => {
    const { rerender } = render(
      <ConfirmDialog open={false} message="Delete it?" onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(<ConfirmDialog open message="Delete it?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Delete it?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('Cancel calls onCancel, Confirm calls onConfirm', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog open message="Sure?" onConfirm={onConfirm} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('while loading: Cancel is disabled, Confirm shows busy, and Escape cannot dismiss it', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    render(<ConfirmDialog open message="Working…" loading onConfirm={() => {}} onCancel={onCancel} />)

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByLabelText('Close')).toBeNull() // Modal's X button, hidden while non-dismissible

    await user.keyboard('{Escape}')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('uses the danger button style by default and the primary style when danger={false}', () => {
    const { rerender } = render(<ConfirmDialog open message="m" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toMatch(/bg-red-600/)

    rerender(<ConfirmDialog open danger={false} message="m" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm' }).className).toMatch(/bg-blue-700/)
  })

  it('honors custom title and button labels', () => {
    render(
      <ConfirmDialog open title="Ban this user?" confirmLabel="Ban" cancelLabel="Never mind"
        message="m" onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(screen.getByText('Ban this user?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ban' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Never mind' })).toBeInTheDocument()
  })
})
