// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import CoverLetterPanel from '../../src/components/scan/CoverLetterPanel'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: vi.fn(), copyToClipboard: vi.fn(async () => true) }))

beforeEach(() => { for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset() })

const LETTER = 'Dear Hiring Manager,\n\nLast year I rebuilt the weekly reporting pack that management used to chase, and vendor queries dropped.\n\nSincerely,\nHannah Walker'

describe('CoverLetterPanel — the person can edit the letter, and a new one never silently replaces their edits', () => {
  it('Edit opens the saved text; Save sends it to the letter endpoint and tells the parent', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.patch.mockResolvedValue({ data: { data: { coverLetterText: LETTER + ' (edited)' } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER }} onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Your letter')
    expect(box).toHaveValue(LETTER)
    await user.type(box, ' (edited)')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ coverLetterText: LETTER + ' (edited)' }))
    expect(api.patch).toHaveBeenCalledWith('/scan/s1/cover-letter', { text: LETTER + ' (edited)' })
  })
  it('Cancel leaves the saved letter alone and sends nothing', async () => {
    const user = userEvent.setup()
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER }} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByLabelText('Your letter'), ' xyz')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.patch).not.toHaveBeenCalled()
    expect(screen.getByText(/Last year I rebuilt/)).toBeInTheDocument()
  })
  it('a failed save says so and keeps the editor open with the text', async () => {
    const user = userEvent.setup()
    api.patch.mockRejectedValue({ response: { data: { message: 'Your resume changed while you were editing. Please reload and try again.' } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER }} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/changed while you were editing/)).toBeInTheDocument()
    expect(screen.getByLabelText('Your letter')).toHaveValue(LETTER)
  })
  it('"Write a new one" asks first when a letter exists, and writes only after "Replace it"', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.post.mockResolvedValue({ data: { data: { coverLetterText: 'Dear Hiring Manager,\n\nNew.' } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER }} onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Write a new one' }))
    expect(api.post).not.toHaveBeenCalled()
    expect(screen.getByTestId('cover-letter-confirm')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep this one' }))
    expect(screen.queryByTestId('cover-letter-confirm')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Write a new one' }))
    await user.click(screen.getByRole('button', { name: 'Replace it' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ coverLetterText: 'Dear Hiring Manager,\n\nNew.' }))
  })
  it('the first letter is written without any confirmation', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { coverLetterText: LETTER } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null }} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Write my cover letter' }))
    expect(api.post).toHaveBeenCalled()
  })
})
