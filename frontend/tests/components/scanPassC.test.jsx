// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../../src/lib/api'
import ResumeDataEditor from '../../src/components/scan/ResumeDataEditor'
import DeliveredResumeEditor from '../../src/components/scan/DeliveredResumeEditor'
import CoverLetterPanel from '../../src/components/scan/CoverLetterPanel'
import ScoreGauge from '../../src/components/scan/ScoreGauge'
import { buildResumeDiff } from '../../src/lib/resumeDiff'

// Scan / ATS pass: the new owner tools and the guards behind them.
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: vi.fn(), copyToClipboard: vi.fn(async () => true) }))
import { downloadBlob, copyToClipboard } from '../../src/lib/utils'

beforeEach(() => { for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset(); downloadBlob.mockClear(); copyToClipboard.mockClear() })

describe('ResumeDataEditor — uploaded files', () => {
  const fileScan = { id: 's1', inputMode: 'file', originalResumeData: null }
  it('offers a preview for a file scan with no structure yet, and hands the result up', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.post.mockResolvedValue({ data: { data: { originalResumeData: { name: 'Jane' } } } })
    render(<ResumeDataEditor scan={fileScan} anonToken="tok" onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Preview what we extracted' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ originalResumeData: { name: 'Jane' } }))
    expect(api.post).toHaveBeenCalledWith('/scan/s1/structure?token=tok')
  })
  it('a failed preview says so and keeps the button', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValue({ response: { data: { message: 'We couldn\'t read the structure of that file just now.' } } })
    render(<ResumeDataEditor scan={fileScan} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Preview what we extracted' }))
    expect(await screen.findByText(/couldn't read the structure/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Preview what we extracted' })).toBeInTheDocument()
  })
  it('once structured, a file scan gets the normal editor with file-specific wording', () => {
    render(<ResumeDataEditor scan={{ ...fileScan, originalResumeData: { name: 'Jane', skills: ['SQL'] } }} onUpdated={vi.fn()} />)
    expect(screen.getByText('The resume we read from your file')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review & edit' })).toBeInTheDocument()
  })
  it('a typed-background scan with no data still renders nothing', () => {
    const { container } = render(<ResumeDataEditor scan={{ id: 's1', inputMode: 'brain_dump', originalResumeData: null }} onUpdated={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('DeliveredResumeEditor', () => {
  const scan = { id: 's1', fixTier: 'FIX', rewrittenResumeData: { name: 'Jane', skills: ['Old'], experience: [] } }
  it('saves an edit to the delivered-resume endpoint, reports the new score and tells the parent', async () => {
    const user = userEvent.setup(); const onSaved = vi.fn(async () => {})
    api.patch.mockResolvedValue({ data: { data: { fixAtsScore: 88, credentialVerified: true } } })
    render(<DeliveredResumeEditor scan={scan} onSaved={onSaved} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Jane')
    await user.clear(name); await user.type(name, 'Jane D')
    await user.click(screen.getByRole('button', { name: /Save & rebuild files/ }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ fixAtsScore: 88, credentialVerified: true }))
    expect(api.patch.mock.calls[0][0]).toBe('/scan/s1/delivered-resume')
    expect(api.patch.mock.calls[0][1].resumeData.name).toBe('Jane D')
    expect(await screen.findByText(/new ATS score 88\/100/)).toBeInTheDocument()
    expect(screen.getByText(/still Passthrough Verified/)).toBeInTheDocument()
  })
  it('says when the edit costs the Verified wording', async () => {
    const user = userEvent.setup()
    api.patch.mockResolvedValue({ data: { data: { fixAtsScore: 72, credentialVerified: false } } })
    render(<DeliveredResumeEditor scan={scan} onSaved={async () => {}} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    await user.click(screen.getByRole('button', { name: /Save & rebuild files/ }))
    expect(await screen.findByText(/Scan Report wording instead of Verified/)).toBeInTheDocument()
  })
  it('a rejected save shows the server\'s reason and keeps the form open with the draft', async () => {
    const user = userEvent.setup()
    api.patch.mockRejectedValue({ response: { data: { message: 'Your resume changed while you were editing.' } } })
    render(<DeliveredResumeEditor scan={scan} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    await user.click(screen.getByRole('button', { name: /Save & rebuild files/ }))
    expect(await screen.findByText(/changed while you were editing/)).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toBeInTheDocument()
  })
  it('a credential-only delivery edits the original content (no rewrite exists)', async () => {
    const user = userEvent.setup()
    render(<DeliveredResumeEditor scan={{ id: 's1', fixTier: 'BADGE', rewrittenResumeData: null, originalResumeData: { name: 'Orig' } }} onSaved={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Edit resume' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Orig')
  })
})

describe('CoverLetterPanel', () => {
  it('writes, shows, copies and downloads the letter', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn()
    api.post.mockResolvedValue({ data: { data: { coverLetterText: 'Dear Hiring Manager,\n\nHi.' } } })
    const { rerender } = render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null }} onUpdated={onUpdated} />)
    await user.click(screen.getByRole('button', { name: 'Write my cover letter' }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith({ coverLetterText: 'Dear Hiring Manager,\n\nHi.' }))
    expect(api.post).toHaveBeenCalledWith('/scan/s1/cover-letter')
    rerender(<CoverLetterPanel scan={{ id: 's1', coverLetterText: 'Dear Hiring Manager,\n\nHi.' }} onUpdated={onUpdated} />)
    expect(screen.getByText(/Dear Hiring Manager/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy text' }))
    expect(copyToClipboard).toHaveBeenCalledWith('Dear Hiring Manager,\n\nHi.')
    api.get.mockResolvedValue({ data: new Blob(['x']) })
    await user.click(screen.getByRole('button', { name: 'Download (.docx)' }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    expect(api.get).toHaveBeenCalledWith('/scan/s1/cover-letter', { responseType: 'blob' })
    expect(screen.getByRole('button', { name: 'Write a new one' })).toBeInTheDocument()
  })
  it('a failed generation is reported and nothing is shown as written', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValue({ response: { data: { message: 'We couldn\'t write the cover letter just now.' } } })
    render(<CoverLetterPanel scan={{ id: 's1', coverLetterText: null }} onUpdated={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Write my cover letter' }))
    expect(await screen.findByText(/couldn't write the cover letter/)).toBeInTheDocument()
  })
})

describe('guards', () => {
  it('resumeDiff survives array fields that are not arrays (string skills, object entries)', () => {
    const wrong = { name: 'J', skills: 'Python, Go', experience: { not: 'an array' }, education: 'x', projects: null, certifications: 5 }
    expect(() => buildResumeDiff(wrong, { ...wrong, skills: ['Python'] })).not.toThrow()
    expect(() => buildResumeDiff({ name: 'J' }, wrong)).not.toThrow()
  })
  it('ScoreGauge shows no verdict (not "Fail") when there is no score yet', () => {
    render(<ScoreGauge score={null} />)
    expect(screen.queryByText('Fail')).not.toBeInTheDocument()
  })
})
