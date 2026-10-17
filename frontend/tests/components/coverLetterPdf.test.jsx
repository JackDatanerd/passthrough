// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import CoverLetterPanel from '../../src/components/scan/CoverLetterPanel'

// Applicant docs pass: the cover letter is also a PDF (the file most people send).
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: vi.fn(), copyToClipboard: vi.fn(async () => true) }))
import { downloadBlob } from '../../src/lib/utils'

beforeEach(() => { for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset(); downloadBlob.mockClear() })

const scan = { id: 's1', coverLetterText: 'Dear Hiring Manager,\n\nHi.' }

describe('CoverLetterPanel — PDF download', () => {
  it('offers the PDF next to the docx only once there is a letter', () => {
    const { rerender } = render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null }} onUpdated={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Download (.pdf)' })).toBeNull()
    rerender(<CoverLetterPanel scan={scan} onUpdated={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Download (.docx)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download (.pdf)' })).toBeInTheDocument()
  })
  it('fetches the rendered PDF as a blob and saves it under the name the server chose', async () => {
    const user = userEvent.setup()
    api.get.mockResolvedValue({ data: new Blob(['%PDF']), headers: { 'content-disposition': 'attachment; filename="jane-doe-cover-letter.pdf"' } })
    render(<CoverLetterPanel scan={scan} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Download (.pdf)' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    expect(api.get).toHaveBeenCalledWith('/scan/s1/cover-letter-pdf', expect.objectContaining({ responseType: 'blob', params: { tz: expect.any(String) } }))
    expect(downloadBlob.mock.calls[0][1]).toBe('jane-doe-cover-letter.pdf')
  })
  it('a failed render is reported and points at the docx', async () => {
    const user = userEvent.setup()
    api.get.mockRejectedValue({ response: { data: { message: "We couldn't generate the PDF just now." } } })
    render(<CoverLetterPanel scan={scan} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Download (.pdf)' }))
    expect(await screen.findByText(/couldn't generate the PDF/)).toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
