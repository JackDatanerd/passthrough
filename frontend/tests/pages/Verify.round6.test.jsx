// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => f }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => <nav /> }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))
vi.mock('../../src/lib/utils', async orig => ({ ...(await orig()), downloadBlob: vi.fn() }))
import api from '../../src/lib/api'
import { downloadBlob } from '../../src/lib/utils'
import Verify from '../../src/pages/Verify'
import { titleFor } from '../../src/lib/pageTitles'

const CODE = 'AB3XY7K2PQ'
const HASH = 'a'.repeat(64)
const page = (over = {}) => ({ data: { success: true, data: {
  candidateFirstName: 'Ada', atsScore: 85, passed: true, verified: true, roleCategory: 'software_engineering', seniorityLevel: 'senior',
  verifiedAt: '2026-03-01T00:00:00.000Z', integrityStatus: 'verified', verificationViews: 3, exposeDocx: true, exposePdf: false,
  fingerprints: { docx: 'c'.repeat(64), pdf: null, previous: [] }, ...over } } })
const httpErr = (status, data = {}) => Object.assign(new Error('x'), { response: { status, data } })
const renderAt = (state) => render(
  <MemoryRouter initialEntries={[{ pathname: `/v/${CODE}`, state }]}>
    <Routes><Route path="/v/:code" element={<Verify />} /></Routes>
  </MemoryRouter>)
beforeEach(() => { cleanup(); vi.clearAllMocks(); document.title = '' })

describe('Verify — round 6: what the tiles claim', () => {
  it('"Scored for" names the job the resume was scored against — there is no "Seniority" or "Field" claim about the candidate', async () => {
    api.get.mockResolvedValue(page())
    renderAt()
    await screen.findByRole('heading', { name: /passthrough verified/i })
    expect(screen.getByText('Scored for')).toBeTruthy()
    expect(screen.getByText('Senior · Software Engineering')).toBeTruthy()
    expect(screen.queryByText('Seniority')).toBeNull()
    expect(screen.queryByText('Field')).toBeNull()
  })
  it('the backend default "mid" is not shown as if the job said so', async () => {
    api.get.mockResolvedValue(page({ seniorityLevel: 'mid' }))
    renderAt()
    await screen.findByText('Scored for')
    expect(screen.getByText('Software Engineering')).toBeTruthy()
    expect(screen.queryByText(/mid/i)).toBeNull()
  })
  it('no field and a default level shows a dash, not a made-up claim', async () => {
    api.get.mockResolvedValue(page({ roleCategory: null, seniorityLevel: 'mid' }))
    renderAt()
    const tile = (await screen.findByText('Scored for')).closest('div')
    expect(tile.textContent).toBe('Scored for—')
  })
  it('the date tile says "Verified" only on a verified page, "Scanned" otherwise', async () => {
    api.get.mockResolvedValue(page())
    renderAt()
    await screen.findByText('Scored for')
    expect(screen.getByText('Verified', { selector: 'p.text-xs' })).toBeTruthy()
    cleanup()
    api.get.mockResolvedValue(page({ verified: false, passed: false, atsScore: 62, integrityStatus: 'verified' }))
    renderAt()
    await screen.findByText('Scored for')
    expect(screen.getByText('Scanned')).toBeTruthy()
    expect(screen.queryByText('Verified', { selector: 'p.text-xs' })).toBeNull()
  })
  it('a long first name wraps instead of overflowing the card', async () => {
    api.get.mockResolvedValue(page({ candidateFirstName: 'x'.repeat(40) }))
    renderAt()
    expect((await screen.findByText('x'.repeat(40))).className).toMatch(/break-words/)
  })
})

describe('Verify — round 6: a stored file that is gone', () => {
  it('says it is missing — not "refresh in a moment" — and is never a green tick', async () => {
    api.get.mockResolvedValue(page({ verified: false, integrityStatus: 'missing' }))
    renderAt()
    await screen.findByRole('heading', { name: /scan report/i })
    expect(screen.getByText(/stored copy of this resume could not be found/i)).toBeTruthy()
    expect(screen.getByText('Stored copy missing')).toBeTruthy()
    expect(screen.queryByText(/refresh in a moment/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: /passthrough verified/i })).toBeNull()
  })
})

describe('Verify — round 6: a file that does not match', () => {
  it('does not accuse: it says what was established and what to do', async () => {
    api.get.mockResolvedValue(page())
    renderAt({ fileCheck: { code: CODE, hash: HASH, kind: 'docx' } })
    const box = (await screen.findByText(/the file you checked/i)).closest('div')
    expect(box.textContent).toMatch(/isn't an exact copy of anything passthrough issued/i)
    expect(box.textContent).toMatch(/re-saving, converting to pdf or printing/i)
    expect(box.textContent).toMatch(/ask the candidate for the original/i)
    expect(box.textContent).not.toMatch(/didn't come from passthrough/i)
    expect(box.querySelector('p.text-red-600')).toBeNull()
  })
})

describe('Verify — round 6: the tab title says what the page says', () => {
  it('the route table starts neutral', () => { expect(titleFor(`/v/${CODE}`)).toBe('Resume verification — Passthrough') })
  it.each([
    [page(), 'Verified resume — Passthrough'],
    [page({ verified: false, passed: false, atsScore: 60 }), 'Scan report — Passthrough'],
  ])('a loaded page', async (resp, title) => {
    api.get.mockResolvedValue(resp)
    renderAt()
    await waitFor(() => expect(document.title).toBe(title))
  })
  it.each([[404, {}, 'Verification not found — Passthrough'], [410, { code: 'REMOVED' }, 'Verification removed — Passthrough'], [410, {}, 'Verification revoked — Passthrough']])('status %s %j', async (status, body, title) => {
    api.get.mockRejectedValue(httpErr(status, body))
    renderAt()
    await waitFor(() => expect(document.title).toBe(title))
  })
})

describe('Verify — round 6: a removed / revoked page reached with a file', () => {
  it('tells the reader the FILE is a genuine Passthrough one', async () => {
    api.get.mockRejectedValue(httpErr(410, { code: 'REMOVED' }))
    renderAt({ fileCheck: { code: CODE, hash: HASH, kind: 'docx' } })
    expect(await screen.findByText(/file you checked is one passthrough issued for this page/i)).toBeTruthy()
    cleanup()
    api.get.mockRejectedValue(httpErr(410, { revokedAt: '2026-03-02T00:00:00Z' }))
    renderAt({ fileCheck: { code: CODE, hash: HASH, kind: 'docx' } })
    expect(await screen.findByText(/file you checked is one passthrough issued for this page/i)).toBeTruthy()
  })
  it('no file, no note — and a different code in state is ignored', async () => {
    api.get.mockRejectedValue(httpErr(410, { code: 'REMOVED' }))
    renderAt()
    await screen.findByRole('heading', { name: /was removed/i })
    expect(screen.queryByText(/file you checked/i)).toBeNull()
    cleanup()
    renderAt({ fileCheck: { code: 'ZZ3XY7K2PQ', hash: HASH, kind: 'docx' } })
    await screen.findByRole('heading', { name: /was removed/i })
    expect(screen.queryByText(/file you checked/i)).toBeNull()
  })
})

describe('Verify — round 6: downloads go through the shared helper', () => {
  it('a successful download hands the blob and the Passthrough filename to downloadBlob', async () => {
    api.get.mockImplementation(url => url.endsWith('/download') ? Promise.resolve({ data: new Blob(['x']) }) : Promise.resolve(page()))
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: /download \.docx/i }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect(downloadBlob.mock.calls[0][1]).toBe(`Passthrough-${CODE}.docx`)
  })
  it('a failed download shows the error and saves nothing', async () => {
    api.get.mockImplementation(url => url.endsWith('/download') ? Promise.reject(httpErr(409, { message: 'no longer matches' })) : Promise.resolve(page()))
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: /download \.docx/i }))
    await screen.findByText(/could not download that file/i)
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
