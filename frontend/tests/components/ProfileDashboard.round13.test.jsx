// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api from '../../src/lib/api'
import BreakdownModal from '../../src/components/dashboard/BreakdownModal'
import StatsRow from '../../src/components/dashboard/StatsRow'
import SavedProfileEditor from '../../src/components/account/SavedProfileEditor'

vi.mock('../../src/lib/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))

// Profile & Dashboard round 13.
//  B3: the four category bars are the ORIGINAL resume's, but the ring above them shows the fixed score once a fix is scored.
//  B4: "Verified links" counts the newest 100 scans only; the card did not say so.
//  B2 (client half): "Save changes" with nothing changed wrote the profile anyway, marking it hand-edited.

const scan = (over = {}) => ({
  id: 's1', status: 'COMPLETE_FAIL', atsScore: 52, fixPurchased: false, fixAtsScore: null, fixTier: null, fixRetryCount: 0,
  verificationCode: null, verificationStatus: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
  jobTitle: 'Analyst', resumeOriginalName: 'cv.pdf', keywordScore: 40, formatScore: 80, sectionsScore: 70, contentScore: 60, ...over,
})
const renderModal = (s) => render(<MemoryRouter><BreakdownModal scan={s} now={Date.now()} onClose={() => {}} /></MemoryRouter>)

describe('B3: the breakdown says which resume its bars describe', () => {
  it('an unfixed scan keeps the plain heading and no note', () => {
    renderModal(scan())
    expect(screen.getByText('What the software sees')).toBeInTheDocument()
    expect(screen.queryByText(/before your fix/i)).toBeNull()
  })
  it('a scan whose fix has been scored names the original resume and its score', () => {
    renderModal(scan({ status: 'FIX_DELIVERED', fixPurchased: true, fixAtsScore: 88 }))
    expect(screen.getByText('What the software saw in your original resume')).toBeInTheDocument()
    expect(screen.getByText(/before your fix \(52\/100\)/i)).toBeInTheDocument()
    expect(screen.queryByText('What the software sees')).toBeNull()
  })
  it('a fix that is bought but not scored yet is still the original resume on screen, so no note', () => {
    renderModal(scan({ status: 'FIX_GENERATING', fixPurchased: true, fixAtsScore: null }))
    expect(screen.getByText('What the software sees')).toBeInTheDocument()
  })
})

describe('B4: Verified links says when it is a count of the latest scans', () => {
  const row = (partial) => render(<MemoryRouter><StatsRow best={80} trend={[60, 80]} verifiedCount={7} quota={null} credits={0} partial={partial} /></MemoryRouter>)
  it('whole history: just the link', () => {
    row(false)
    expect(screen.queryByText(/latest 100 scans/i)).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Proof' })).toBeInTheDocument()
  })
  it('only the newest 100 were counted: the card says so, and still links to Proof', () => {
    row(true)
    const notes = screen.getAllByText(/latest 100 scans/i)
    expect(notes.some(n => /In your latest 100 scans/.test(n.textContent))).toBe(true)
    expect(screen.getByRole('link', { name: 'Open Proof' })).toHaveAttribute('href', '/dashboard/proof')
  })
})

describe('B2: Save changes with nothing changed', () => {
  const RESUME = { name: 'Jane Doe', summary: 'Ops lead.', skills: ['SQL'] }
  beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.get.mockResolvedValue({ data: { data: { resumeData: RESUME, version: 'v1' } } }) })
  it('closes without writing anything', async () => {
    const user = userEvent.setup(); const onSaved = vi.fn(); const onClose = vi.fn()
    render(<SavedProfileEditor onSaved={onSaved} onClose={onClose} />)
    await screen.findByLabelText('Name')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(api.put).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })
  it('typed changes are still written, with the version they were made against', async () => {
    const user = userEvent.setup(); api.put.mockResolvedValue({ data: { success: true } })
    const onSaved = vi.fn(); const onClose = vi.fn()
    render(<SavedProfileEditor onSaved={onSaved} onClose={onClose} />)
    await user.type(await screen.findByLabelText('Name'), 'x')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1))
    expect(api.put.mock.calls[0][1]).toMatchObject({ version: 'v1', resumeData: { name: 'Jane Doex' } })
    expect(onSaved).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled()
  })
})
