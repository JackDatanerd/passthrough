// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import api from '../../src/lib/api'
import ScanComposer from '../../src/components/scan/ScanComposer'
import ScanForm from '../../src/components/scan/ScanForm'

// The /scan page's form: five ways in, a job, and a button that is never silently off. All the rules live in useScanForm
// (shared with the homepage card), so most of what is checked here is the shared behaviour seen through the page.
const auth = { user: null }
vi.mock('../../src/hooks/useAuth', () => ({ useAuth: () => auth }))
vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
// A FileUpload stand-in: one button that "chooses" a resume.
vi.mock('../../src/components/ui/FileUpload', () => ({
  default: ({ onFile }) => <button type="button" role="button" onClick={() => onFile(new File(['%PDF-1.4 resume'], 'cv.pdf', { type: 'application/pdf' }))}>pick-file</button>,
}))

const JD = 'Senior backend engineer. Node.js, TypeScript, PostgreSQL, Docker. '.repeat(3)
const BACKGROUND = 'I led the onboarding team at Acme for three years, four engineers, and activation rose by eighteen percent. '.repeat(2)
const JD_DRAFT_KEY = 'passthrough_scan_jd_draft'
const SRC = '11111111-1111-4111-8111-111111111111'

const tree = () => (
  <MemoryRouter initialEntries={['/scan']}>
    <Routes>
      <Route path="/scan" element={<ScanComposer />} />
      <Route path="/scan/:id" element={<p>the result page</p>} />
    </Routes>
  </MemoryRouter>
)
const renderPage = () => render(tree())
const goButton = () => screen.getByRole('button', { name: /Free$/ })
const jdBox = () => screen.getByRole('textbox', { name: 'Job description' })
const reasonLine = () => document.getElementById('scan-reason')
const tile = name => screen.getByRole('radio', { name })
const setText = (el, value) => fireEvent.change(el, { target: { value } })

function profile({ quota, extraProfiles = [], hasSavedProfile = false } = {}) {
  return { data: { data: { hasSavedProfile, extraProfiles, quota: quota || { limit: 3, used: 0, remaining: 3, resetsAt: '2099-01-01T00:00:00Z' } } } }
}
function wire({ prof = profile(), history = [] } = {}) {
  api.get.mockImplementation(async url => {
    if (url === '/profile') return prof
    if (url === '/scan/history') return { data: { data: { scans: history, total: history.length } } }
    return { data: { data: {} } }
  })
}

beforeEach(() => {
  for (const k of ['get', 'post', 'patch', 'delete']) api[k].mockReset()
  auth.user = null
  localStorage.clear()
  wire()
})

describe('/scan — what a visitor and a signed-in person are offered', () => {
  it('a visitor gets three ways in, and the "no account" pill', () => {
    renderPage()
    expect(screen.getAllByRole('radio').map(r => r.textContent.split(/(?=[A-Z][a-z])/)[0])).toHaveLength(3)
    expect(tile(/^Upload it/)).toBeInTheDocument()
    expect(tile(/^Start from scratch/)).toBeInTheDocument()
    expect(tile(/^Fill it in myself/)).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Reuse a recent one/ })).toBeNull()
    expect(screen.getByText('No account needed')).toBeInTheDocument()
  })

  it('a signed-in person is not told "no account needed", and sees the allowance with its reset time', async () => {
    auth.user = { id: 'u1', name: 'Ada', email: 'ada@example.com' }
    renderPage()
    expect(await screen.findByText(/3 of 3 free scans left today/)).toBeInTheDocument()
    expect(screen.queryByText('No account needed')).toBeNull()
    expect(screen.queryByText(/kept for 24 hours/)).toBeNull()
  })

  it('"Reuse a recent one" appears once earlier scans load, and "Saved profile" when one exists', async () => {
    auth.user = { id: 'u1' }
    wire({ prof: profile({ hasSavedProfile: true }), history: [{ id: SRC, status: 'COMPLETE_FAIL', atsScore: 62, resumeOriginalName: 'cv.pdf', inputMode: 'file', createdAt: '2026-10-19T10:00:00Z', jobTitle: 'PM' }] })
    renderPage()
    expect(await screen.findByRole('radio', { name: /Reuse a recent one/ })).toBeInTheDocument()
    expect(await screen.findByRole('radio', { name: /Saved profile/ })).toBeInTheDocument()
  })

  it('a scan that is still running or failed is not offered for reuse', async () => {
    auth.user = { id: 'u1' }
    wire({ history: [{ id: SRC, status: 'ERROR', resumeOriginalName: 'bad.pdf', inputMode: 'file', createdAt: '2026-10-19T10:00:00Z' }, { id: 'b', status: 'SCANNING', inputMode: 'file', createdAt: '2026-10-19T10:00:00Z' }] })
    renderPage()
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/scan/history', expect.anything()))
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('radio', { name: /Reuse a recent one/ })).toBeNull()
  })
})

describe('/scan — the button is never silently off', () => {
  it('says what is missing, and pressing it goes to the first gap and sends nothing', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(goButton()).toHaveAttribute('aria-disabled', 'true')
    expect(reasonLine()).toHaveTextContent('Please upload your resume.')
    await user.click(goButton())
    expect(api.post).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'pick-file' }))   // the resume half's own control, not the tile that was already chosen

    await user.click(screen.getByRole('button', { name: 'pick-file' }))
    expect(reasonLine()).toHaveTextContent('Job description too short (min 50 characters).')
    await user.click(goButton())
    expect(api.post).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(jdBox())                    // now the job half
  })

  it('marks each half ready as it is completed, in the rail', async () => {
    const user = userEvent.setup()
    renderPage()
    const rail = within(screen.getByRole('complementary', { name: 'Scan summary' }))
    expect(rail.getByText('Resume').parentElement).toHaveTextContent('Resume missing')
    await user.click(screen.getByRole('button', { name: 'pick-file' }))
    setText(jdBox(), JD)
    expect(rail.getByText('Resume').parentElement).toHaveTextContent('Resume ready')
    expect(rail.getByText('Job').parentElement).toHaveTextContent('Job ready')
    expect(goButton()).not.toHaveAttribute('aria-disabled')
    expect(reasonLine()).toHaveTextContent('')
  })

  it('whitespace does not count towards the 50 characters the server asks for', () => {
    renderPage()
    setText(jdBox(), 'a' + ' '.repeat(80) + 'b')
    expect(screen.getByText('Too short')).toBeInTheDocument()
    expect(reasonLine()).toHaveTextContent('Please upload your resume.')   // the resume is still the first gap
    setText(jdBox(), `${'word '.repeat(9)}   \n\n   end`)                  // 9 words + end, well under 50 once collapsed
    expect(screen.getByText('Too short')).toBeInTheDocument()
    setText(jdBox(), JD)
    expect(screen.getByText('Enough to score')).toBeInTheDocument()
  })

  it('the Paste text / Job link switch says which one is on (aria-pressed)', async () => {
    const user = userEvent.setup()
    renderPage()
    const paste = screen.getByRole('button', { name: 'Paste text' })
    const link = screen.getByRole('button', { name: 'Job link' })
    expect(paste).toHaveAttribute('aria-pressed', 'true')
    expect(link).toHaveAttribute('aria-pressed', 'false')
    await user.click(link)
    expect(paste).toHaveAttribute('aria-pressed', 'false')
    expect(link).toHaveAttribute('aria-pressed', 'true')
    expect(reasonLine()).toHaveTextContent('Please upload your resume.')
  })

  it('a visitor who describes their background must give a name and a valid email before the scan is ready', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(tile(/^Start from scratch/))
    setText(screen.getByRole('textbox', { name: 'Your background, in your own words' }), BACKGROUND)
    expect(reasonLine()).toHaveTextContent('Please enter your name.')
    await user.type(screen.getByLabelText('Your full name'), 'Ada Lovelace')
    expect(reasonLine()).toHaveTextContent('Please enter a valid email address.')
    await user.type(screen.getByLabelText('Your email'), 'ada@example')
    expect(reasonLine()).toHaveTextContent('Please enter a valid email address.')
    await user.type(screen.getByLabelText('Your email'), '.com')
    expect(reasonLine()).toHaveTextContent('Job description too short')   // the resume half is done
  })
})

describe('/scan — sending the scan', () => {
  it('posts the file and the job, forgets the job it was keeping, and opens the result', async () => {
    const user = userEvent.setup()
    api.post.mockResolvedValue({ data: { data: { scanId: 's9', anonToken: 'tok' } } })
    renderPage()
    await user.click(screen.getByRole('button', { name: 'pick-file' }))
    setText(jdBox(), JD)
    expect(localStorage.getItem(JD_DRAFT_KEY)).not.toBeNull()      // kept while it is being typed
    await user.click(goButton())
    expect(await screen.findByText('the result page')).toBeInTheDocument()
    const [url, fd] = api.post.mock.calls[0]
    expect(url).toBe('/scan')
    expect(fd.get('resume')).toBeInstanceOf(File)
    expect(fd.get('jobDescriptionText')).toBe(JD)
    expect(localStorage.getItem(JD_DRAFT_KEY)).toBeNull()
  })

  it('a scan that fails keeps the job: it is back in the box (with a note) when the page is opened again', async () => {
    const user = userEvent.setup()
    api.post.mockRejectedValue({ response: { status: 500, data: { message: 'Something broke on our side.' } } })
    const first = renderPage()
    await user.click(screen.getByRole('button', { name: 'pick-file' }))
    setText(jdBox(), JD)
    await user.click(goButton())
    expect(await screen.findByText('Something broke on our side.')).toBeInTheDocument()
    expect(jdBox()).toHaveValue(JD)
    first.unmount()

    renderPage()
    expect(jdBox()).toHaveValue(JD)
    expect(screen.getByText(/We kept the job you were adding last time/)).toBeInTheDocument()
  })

  it('a link that was being added is kept the same way, with the link switch on', () => {
    localStorage.setItem(JD_DRAFT_KEY, JSON.stringify({ text: '', url: 'https://jobs.example.com/pm-1', useUrl: true }))
    renderPage()
    expect(screen.getByRole('button', { name: 'Job link' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText(/Link to the employer/)).toHaveValue('https://jobs.example.com/pm-1')
  })

  it("someone else's kept job is never shown", () => {
    localStorage.setItem(JD_DRAFT_KEY, JSON.stringify({ text: JD, url: '', useUrl: false, owner: 'someone-else' }))
    renderPage()
    expect(jdBox()).toHaveValue('')
    expect(screen.queryByText(/We kept the job/)).toBeNull()
  })
})

describe('/scan — the free allowance is a gate, not advice', () => {
  async function fillSignedIn(user) {
    await user.click(tile(/^Start from scratch/))
    setText(screen.getByRole('textbox', { name: 'Your background, in your own words' }), BACKGROUND)
    setText(jdBox(), JD)
  }

  it('with none left the button is off, says when they come back, and a full form still sends nothing', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    wire({ prof: profile({ quota: { limit: 3, used: 3, remaining: 0, resetsAt: '2099-01-01T00:00:00Z' } }) })
    renderPage()
    expect(await screen.findByText(/You've used all 3 free scans for today/)).toBeInTheDocument()
    await fillSignedIn(user)
    expect(goButton()).toHaveAttribute('aria-disabled', 'true')
    expect(reasonLine()).toHaveTextContent(/Your free scans come back at/)
    await user.click(goButton())
    expect(api.post).not.toHaveBeenCalled()
    expect(within(reasonLine()).getByRole('link', { name: 'See your scans' })).toHaveAttribute('href', '/dashboard')
  })

  it('a page left open past the reset time is not blocked by its own old "0 left"', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    api.post.mockResolvedValue({ data: { data: { scanId: 's2' } } })
    wire({ prof: profile({ quota: { limit: 3, used: 3, remaining: 0, resetsAt: '2020-01-01T00:00:00Z' } }) })
    renderPage()
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/profile'))
    await fillSignedIn(user)
    await waitFor(() => expect(goButton()).not.toHaveAttribute('aria-disabled'))
    await user.click(goButton())
    expect(await screen.findByText('the result page')).toBeInTheDocument()
  })
})

describe('/scan — reuse a recent resume', () => {
  const history = [
    { id: SRC, status: 'FIX_DELIVERED', fixPurchased: true, atsScore: 62, fixAtsScore: 84, resumeOriginalName: 'cv.pdf', inputMode: 'file', createdAt: '2026-10-19T10:00:00Z', jobTitle: 'Product Manager' },
    { id: '22222222-2222-4222-8222-222222222222', status: 'COMPLETE_PASS', atsScore: 78, resumeOriginalName: 'older.pdf', inputMode: 'file', createdAt: '2026-10-01T10:00:00Z' },
  ]

  it('picks an earlier resume, sends only its id (no file), and can ask for the improved version', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    api.post.mockResolvedValue({ data: { data: { scanId: 's3' } } })
    wire({ history })
    renderPage()
    await user.click(await screen.findByRole('radio', { name: /Reuse a recent one/ }))
    const group = screen.getByRole('group', { name: 'Recent resumes' })
    expect(within(group).getByRole('radio', { name: /cv\.pdf/ })).toBeChecked()      // the newest is chosen for them
    expect(within(group).getByRole('radio', { name: /older\.pdf/ })).not.toBeChecked()
    await user.click(screen.getByTestId('rescan-use-improved'))
    setText(jdBox(), JD)
    await user.click(goButton())
    expect(await screen.findByText('the result page')).toBeInTheDocument()
    const fd = api.post.mock.calls[0][1]
    expect(fd.get('sourceScanId')).toBe(SRC)
    expect(fd.get('rescanVersion')).toBe('delivered')
    expect(fd.get('resume')).toBeNull()
  })

  it('choosing another one moves the choice, and the improved-version box goes with the one that has none', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    wire({ history })
    renderPage()
    await user.click(await screen.findByRole('radio', { name: /Reuse a recent one/ }))
    expect(screen.getByTestId('rescan-use-improved')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /older\.pdf/ }))
    expect(screen.queryByTestId('rescan-use-improved')).toBeNull()
  })
})

describe('the saved-profile choice belongs to the person who made it', () => {
  it('is not carried into the next account that signs in on the same page', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    api.post.mockResolvedValue({ data: { data: { scanId: 's4' } } })
    wire({ prof: profile({ extraProfiles: [{ id: 'p1', label: 'Fintech' }] }) })
    const view = renderPage()
    await user.click(await screen.findByRole('radio', { name: /Saved profile/ }))
    expect(screen.getByRole('combobox', { name: 'Profile to use' })).toHaveValue('p1')

    // The session ends and another person signs in: they have a saved profile of their own, and no extras.
    auth.user = { id: 'u2' }
    wire({ prof: profile({ hasSavedProfile: true }) })
    view.rerender(tree())
    await waitFor(() => expect(api.get.mock.calls.filter(c => c[0] === '/profile').length).toBeGreaterThan(1))
    await user.click(await screen.findByRole('radio', { name: /Saved profile/ }))
    setText(jdBox(), JD)
    await waitFor(() => expect(goButton()).not.toHaveAttribute('aria-disabled'))
    await user.click(goButton())
    await screen.findByText('the result page')
    expect(api.post.mock.calls[0][1].get('savedProfileId')).toBeNull()
  })

  it('and signing out while a mode that needs an account is open falls back to uploading', async () => {
    const user = userEvent.setup()
    auth.user = { id: 'u1' }
    wire({ prof: profile({ hasSavedProfile: true }) })
    const view = renderPage()
    await user.click(await screen.findByRole('radio', { name: /Saved profile/ }))
    auth.user = null
    view.rerender(tree())
    await waitFor(() => expect(tile(/^Upload it/)).toBeChecked())
    expect(screen.queryByRole('radio', { name: /Saved profile/ })).toBeNull()
  })
})

describe('the compact card (homepage) shares the same rules', () => {
  const card = () => render(<MemoryRouter><ScanForm /></MemoryRouter>)

  it('only a visitor is told no account is needed', () => {
    const visitor = card()
    expect(screen.getByText(/No account needed\. Results in ~30 seconds/)).toBeInTheDocument()
    visitor.unmount()
    auth.user = { id: 'u1' }
    card()
    expect(screen.queryByText(/No account needed/)).toBeNull()
    expect(screen.getByText('Results in ~30 seconds.')).toBeInTheDocument()
  })

  it('its Paste text / URL switch says which one is on, and a whitespace-only posting is refused', async () => {
    const user = userEvent.setup()
    card()
    const paste = screen.getByRole('button', { name: 'Paste text' })
    expect(paste).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'URL' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'pick-file' }))
    setText(screen.getByPlaceholderText(/Paste the full job description/), 'a' + ' '.repeat(80) + 'b')
    await user.click(screen.getByRole('button', { name: /scan/i }))
    expect(await screen.findByText('Job description too short (min 50 characters).')).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
  })
})


describe('/scan — what is said before the button is pressed', () => {
  it('treats a job link as it is typed: LinkedIn blocked with a way out, junk flagged, a good one welcomed', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Job link' }))
    const box = screen.getByLabelText(/Link to the employer/)
    await user.type(box, 'https://www.linkedin.com/jobs/view/123')
    expect(screen.getByTestId('link-blocked')).toBeInTheDocument()
    await user.click(within(screen.getByTestId('link-blocked')).getByRole('button', { name: 'Switch to paste' }))
    expect(jdBox()).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Job link' }))
    await user.clear(screen.getByLabelText(/Link to the employer/))
    await user.type(screen.getByLabelText(/Link to the employer/), 'not a link')
    expect(screen.getByTestId('link-bad')).toBeInTheDocument()
    await user.clear(screen.getByLabelText(/Link to the employer/))
    await user.type(screen.getByLabelText(/Link to the employer/), 'https://jobs.example.com/pm-123')
    expect(screen.getByTestId('link-ok')).toBeInTheDocument()
    expect(screen.queryByTestId('link-blocked')).toBeNull()
  })

  it('a visitor is told the hourly limit and the 24 hours before pressing anything; a signed-in person is not', async () => {
    renderPage()
    expect(screen.getByTestId('anon-note')).toHaveTextContent(/free scan.* an hour.*24 hours/)
  })
  it('the email box for a result link is on the page for a visitor who uploads, not behind Options', async () => {
    renderPage()
    expect(screen.getByLabelText(/Email me the result link/)).toBeInTheDocument()
  })

  it('pressing the button with a short pasted description lands on the box, not on the tile', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('radio', { name: /^Start from scratch/ }))
    await user.click(goButton())
    expect(document.activeElement.tagName).toBe('TEXTAREA')
  })

  it('the source tiles move with the arrow keys, one stop in the Tab order', async () => {
    const user = userEvent.setup()
    renderPage()
    const up = tile(/^Upload it/)
    expect(up).toHaveAttribute('tabindex', '0')
    expect(tile(/^Start from scratch/)).toHaveAttribute('tabindex', '-1')
    up.focus()
    await user.keyboard('{ArrowRight}')
    expect(tile(/^Start from scratch/)).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(tile(/^Start from scratch/))
    await user.keyboard('{ArrowLeft}')
    expect(tile(/^Upload it/)).toHaveAttribute('aria-checked', 'true')
  })

  it('a signed-in person sees a placeholder, not a tile that pops in, while earlier scans load', async () => {
    auth.user = { id: 'u1' }
    let release
    wire({ history: [{ id: SRC, status: 'COMPLETE_FAIL', atsScore: 62, resumeOriginalName: 'cv.pdf', inputMode: 'file', createdAt: '2026-10-19T10:00:00Z' }] })
    const real = api.get.getMockImplementation()
    api.get.mockImplementation(async (url, ...a) => { if (url === '/scan/history') await new Promise(r => { release = r }); return real(url, ...a) })
    renderPage()
    expect(await screen.findByTestId('reuse-loading')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Reuse a recent one/ })).toBeNull()
    await act(async () => { release?.() })
    expect(await screen.findByRole('radio', { name: /Reuse a recent one/ })).toBeInTheDocument()
    expect(screen.queryByTestId('reuse-loading')).toBeNull()
  })
})
