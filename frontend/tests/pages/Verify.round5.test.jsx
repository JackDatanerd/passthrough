// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => f }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => <nav /> }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))
import api from '../../src/lib/api'
import Verify from '../../src/pages/Verify'

const CODE = 'AB3XY7K2PQ'
const CUR_DOCX = 'c'.repeat(64), CUR_PDF = 'd'.repeat(64), OLD_DOCX = 'a'.repeat(64)
const page = (over = {}) => ({ data: { success: true, data: {
  candidateFirstName: 'Ada', atsScore: 85, passed: true, verified: true, roleCategory: 'ENGINEERING', seniorityLevel: 'senior',
  verifiedAt: '2026-03-01T00:00:00.000Z', integrityStatus: 'verified', verificationViews: 3, exposeDocx: false, exposePdf: false,
  fingerprints: { docx: CUR_DOCX, pdf: CUR_PDF, previous: [{ kind: 'docx', hash: OLD_DOCX, at: '2026-02-01T00:00:00.000Z' }] },
  ...over } } })
const httpErr = status => Object.assign(new Error('x'), { response: { status, data: {} } })

function renderAt(state, path = `/v/${CODE}`) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes><Route path="/v/:code" element={<Verify />} /><Route path="/check" element={<div>check page</div>} /></Routes>
    </MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('Verify — arriving from /check with a file (round 5, G1)', () => {
  it('an EARLIER file is called out above the headline, with when it was superseded', async () => {
    api.get.mockResolvedValue(page())
    renderAt({ fileCheck: { code: CODE, hash: OLD_DOCX, kind: 'docx' } })
    const callout = await screen.findByText(/the file you checked/i)
    const box = callout.closest('div')
    expect(box.textContent).toMatch(/matches an earlier \.docx, current until/i)
    expect(box.textContent).toMatch(/not the current one/i)
    // and it comes BEFORE the green headline, so it is not read as applying to the file
    const headline = screen.getByRole('heading', { name: /passthrough verified/i })
    expect(callout.compareDocumentPosition(headline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the CURRENT file is confirmed as such', async () => {
    api.get.mockResolvedValue(page())
    renderAt({ fileCheck: { code: CODE, hash: CUR_PDF, kind: 'pdf' } })
    expect((await screen.findByText(/the file you checked/i)).closest('div').textContent).toMatch(/current, unmodified file/i)
  })

  it('shows the result once — the bottom card does not repeat it', async () => {
    api.get.mockResolvedValue(page())
    renderAt({ fileCheck: { code: CODE, hash: CUR_PDF, kind: 'pdf' } })
    await screen.findByText(/the file you checked/i)
    expect(screen.getAllByText(/current, unmodified file/i)).toHaveLength(1)
  })

  it('a hand-edited location state for a DIFFERENT code is ignored', async () => {
    api.get.mockResolvedValue(page())
    renderAt({ fileCheck: { code: 'ZZ3XY7K2PQ', hash: OLD_DOCX, kind: 'docx' } })
    await screen.findByRole('heading', { name: /passthrough verified/i })
    expect(screen.queryByText(/the file you checked/i)).toBeNull()
  })

  it('no state, no callout — the page is exactly as before', async () => {
    api.get.mockResolvedValue(page())
    renderAt(undefined)
    await screen.findByRole('heading', { name: /passthrough verified/i })
    expect(screen.queryByText(/the file you checked/i)).toBeNull()
  })
})

describe('Verify — failure states (round 5, G6)', () => {
  it.each([
    [404, /verification not found/i],
    [429, /too many lookups/i],
    [500, /couldn't load this page/i],
  ])('status %s has a heading and the right next step', async (status, name) => {
    api.get.mockRejectedValue(httpErr(status))
    renderAt(undefined)
    expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument()
  })

  it('"not found" sends the reader to look it up by file or code', async () => {
    api.get.mockRejectedValue(httpErr(404))
    renderAt(undefined)
    const link = await screen.findByRole('link', { name: /look it up by file or code/i })
    expect(link.getAttribute('href')).toBe('/check')
  })

  it('the file input on the page is labelled', async () => {
    api.get.mockResolvedValue(page())
    renderAt(undefined)
    expect(await screen.findByLabelText(/choose the \.docx or \.pdf you were sent/i)).toBeInTheDocument()
  })
})
