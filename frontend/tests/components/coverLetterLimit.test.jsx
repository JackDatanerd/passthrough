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

const LETTER = 'Dear Hiring Manager,\n\nLast year I rebuilt the weekly reporting pack that management used to chase.\n\nSincerely,\nAmina Otieno'

describe('CoverLetterPanel — a bonus with a visible allowance', () => {
  it('presents the letter as a bonus included with the purchase', () => {
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null, coverLetterCount: 0, coverLetterLimit: 3 }} onUpdated={vi.fn()} />)
    expect(screen.getByText('Bonus')).toBeInTheDocument()
    expect(screen.getByText(/Included with your purchase/)).toBeInTheDocument()
  })

  it('says how many letters are left, and that hand edits do not use one', () => {
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER, coverLetterCount: 1, coverLetterLimit: 3 }} onUpdated={vi.fn()} />)
    const a = screen.getByTestId('cover-letter-allowance')
    expect(a).toHaveTextContent('2 of 3 letters left')
    expect(a).toHaveTextContent(/Editing a letter by hand doesn't use one/)
  })

  it('shows no allowance and disables nothing when the server sent no limit (an older response)', () => {
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null }} onUpdated={vi.fn()} />)
    expect(screen.queryByTestId('cover-letter-allowance')).toBeNull()
    expect(screen.getByRole('button', { name: 'Write my cover letter' })).toBeEnabled()
  })

  it('the replace prompt says it uses one letter and how many remain', async () => {
    const user = userEvent.setup()
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER, coverLetterCount: 1, coverLetterLimit: 3 }} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Write a new one' }))
    expect(screen.getByTestId('cover-letter-confirm')).toHaveTextContent(/uses 1 of your 3 letters; 1 will be left/)
  })

  it('at the limit with a letter: no "Write a new one", the letter stays editable and downloadable', () => {
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: LETTER, coverLetterCount: 3, coverLetterLimit: 3 }} onUpdated={vi.fn()} />)
    expect(screen.getByTestId('cover-letter-allowance')).toHaveTextContent(/used all 3 letters/)
    expect(screen.queryByRole('button', { name: 'Write a new one' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download (.docx)' })).toBeEnabled()
  })

  it('at the limit with no letter (cleared by a resume edit): the write button is disabled', () => {
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null, coverLetterCount: 2, coverLetterLimit: 2 }} onUpdated={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Write my cover letter' })).toBeDisabled()
  })

  it('passes the new count and limit up after a letter is written', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.post.mockResolvedValue({ data: { data: { coverLetterText: LETTER, coverLetterCount: 1, coverLetterLimit: 5 } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null, coverLetterCount: 0, coverLetterLimit: 5 }} onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Write my cover letter' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ coverLetterText: LETTER, coverLetterCount: 1, coverLetterLimit: 5 }))
  })

  it('when the server says the limit is reached (another tab used the last one), shows the allowance as spent', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.post.mockRejectedValue({ response: { status: 409, data: { code: 'COVER_LETTER_LIMIT', coverLetterLimit: 2, message: "You've used all 2 cover letters that come with this resume." } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null, coverLetterCount: 1, coverLetterLimit: 2 }} onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Write my cover letter' }))
    expect(await screen.findByText(/used all 2 cover letters/)).toBeInTheDocument()
    expect(onUpdated).toHaveBeenCalledWith({ coverLetterCount: 2, coverLetterLimit: 2 })
  })
})
