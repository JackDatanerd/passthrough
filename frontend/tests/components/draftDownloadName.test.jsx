// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import ResumeDataEditor from '../../src/components/scan/ResumeDataEditor'
import { saveBlobResponse } from '../../src/lib/utils'

// Applicant docs pass 3: the free-draft download takes its name from the server (accent-aware), not a stem built here.
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), saveBlobResponse: vi.fn() }))

const scan = { id: 's1', originalResumeData: { name: 'José Núñez', experience: [{ company: 'Acme', title: 'Mgr', dates: '2020', bullets: ['a'] }], education: [], skills: ['SQL'] } }
beforeEach(() => { api.get.mockReset(); saveBlobResponse.mockClear() })

describe('ResumeDataEditor draft download', () => {
  it.each([['docx', /\.docx/, 'download-draft'], ['pdf', /\.pdf/, 'download-draft-pdf']])('%s: hands the response to saveBlobResponse so the server\'s filename wins', async (type, ext, path) => {
    const user = userEvent.setup()
    const res = { data: new Blob(['x']), headers: { 'content-disposition': 'attachment; filename="jose-nunez-resume-draft.' + type + '"' } }
    api.get.mockResolvedValue(res)
    render(<ResumeDataEditor scan={scan} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: new RegExp(type === 'pdf' ? 'pdf' : 'docx', 'i') }))
    await waitFor(() => expect(saveBlobResponse).toHaveBeenCalled())
    expect(api.get.mock.calls[0][0]).toMatch(new RegExp(path + '$'))
    expect(saveBlobResponse.mock.calls[0][0]).toBe(res)
    // The fallback has no hand-built (and accent-mangled) stem.
    expect(saveBlobResponse.mock.calls[0][1]).toMatch(ext)
    expect(saveBlobResponse.mock.calls[0][1]).not.toMatch(/nu-n-ez|jose/i)
  })
})
