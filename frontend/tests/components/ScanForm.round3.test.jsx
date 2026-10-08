// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanForm from '../../src/components/scan/ScanForm'

// Scan / ATS round 3 — G6 (an anonymous FILE upload can ask for its link by email) and the long-JD wording (G5).
const auth = { user: null }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
// A FileUpload stand-in: one button that "chooses" a resume.
vi.mock('../../src/components/ui/FileUpload', () => ({
  default: ({ onFile }) => <button type="button" onClick={() => onFile(new File(['%PDF-1.4 resume'], 'cv.pdf', { type: 'application/pdf' }))}>pick-file</button>,
}))

const JD = 'Senior backend engineer. Node.js, TypeScript, PostgreSQL, Docker. '.repeat(3)
const renderForm = () => render(<MemoryRouter><ScanForm /></MemoryRouter>)
beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  api.get.mockResolvedValue({ data: { data: {} } })
  auth.user = null
  localStorage.clear()
})

async function fillAndSubmit(user, email) {
  await user.click(screen.getByRole('button', { name: 'pick-file' }))
  if (email !== undefined) await user.type(screen.getByLabelText(/Email address for a link/), email)
  await user.type(screen.getByPlaceholderText(/Paste the full job description/), JD)
  await user.click(screen.getByRole('button', { name: /scan/i }))
}

describe('ScanForm — optional recovery email for an anonymous upload (G6)', () => {
  it('an anonymous visitor sees the optional field; a signed-in one does not', () => {
    renderForm()
    expect(screen.getByLabelText(/Email address for a link/)).toBeInTheDocument()
    auth.user = { id: 'u1' }
    renderForm()
    expect(screen.getAllByLabelText(/Email address for a link/)).toHaveLength(1)   // still just the first render's
  })
  it('sends contactEmail with the upload when one was given', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { scanId: 's1', anonToken: 't' } } })
    renderForm()
    await fillAndSubmit(user, 'jane@example.com')
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const fd = api.post.mock.calls[0][1]
    expect(fd.get('contactEmail')).toBe('jane@example.com')
    expect(fd.get('resume')).toBeInstanceOf(File)
  })
  it('sends no contactEmail at all when it was left blank', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { scanId: 's1', anonToken: 't' } } })
    renderForm()
    await fillAndSubmit(user)
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1].has('contactEmail')).toBe(false)
  })
  it('a malformed address stops the submit and says so', async () => {
    const user = userEvent.setup()
    renderForm()
    await fillAndSubmit(user, 'not-an-email')
    expect(await screen.findByText(/valid email address, or leave it blank/)).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})

describe('ScanForm — a long pasted job description is trimmed sensibly, not cut off (G5)', () => {
  it('says the intro/benefits go first and that the result shows what was scored', async () => {
    const user = userEvent.setup()
    renderForm()
    const box = screen.getByPlaceholderText(/Paste the full job description/)
    await user.click(box)
    await user.paste('requirement '.repeat(500))   // 6000 chars > 5000
    expect(screen.getByText(/we'll trim the company intro, benefits and legal text first/)).toBeInTheDocument()
    expect(screen.queryByText(/Only the first/)).not.toBeInTheDocument()
  })
})
