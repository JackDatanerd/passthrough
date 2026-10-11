// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => f }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => <nav /> }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))
import api from '../../src/lib/api'
import Verify from '../../src/pages/Verify'
import { extractSha256 } from '../../src/lib/fileFingerprint'

// Round-9 (fresh clone) audit of Section 7 (Verify) — page side.
const CODE = 'AB3XY7K2PQ'
const CUR_DOCX = 'c'.repeat(64), CUR_PDF = 'd'.repeat(64), OLD_DOCX = 'a'.repeat(64)
const page = (over = {}) => ({ data: { success: true, data: {
  candidateFirstName: 'Ada', atsScore: 85, passed: true, verified: true, roleCategory: 'ENGINEERING', seniorityLevel: 'senior',
  verifiedAt: '2026-03-01T00:00:00.000Z', integrityStatus: 'verified', integrityCheckedAt: '2026-03-02T14:05:00.000Z', verificationViews: 3, exposeDocx: false, exposePdf: false,
  fingerprints: { docx: CUR_DOCX, pdf: CUR_PDF, previous: [{ kind: 'docx', hash: OLD_DOCX, at: '2026-02-01T00:00:00.000Z' }] },
  ...over } } })

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/v/${CODE}`]}>
      <Routes><Route path="/v/:code" element={<Verify />} /></Routes>
    </MemoryRouter>)
}
// jsdom's File has no arrayBuffer(), which the page's sha256Hex calls — give the test files one, and compute the
// expected digest the same way the page does.
function mkFile(text, name, type) {
  const bytes = new TextEncoder().encode(text)
  const f = new File([bytes], name, { type })
  f.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return f
}
async function sha(file) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(b => b.toString(16).padStart(2, '0')).join('') }
const fileInput = () => screen.getByLabelText(/choose the \.docx or \.pdf you were sent/i)
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('extractSha256 — what shasum / certutil actually print', () => {
  const h = 'ab'.repeat(32)
  it('takes a bare hash, an upper-case one, and `hash  filename`', () => {
    expect(extractSha256(h)).toBe(h)
    expect(extractSha256(h.toUpperCase())).toBe(h)
    expect(extractSha256(`${h}  resume.pdf`)).toBe(h)
    expect(extractSha256(`SHA256:${h}`)).toBe(h)
  })
  it('takes a whole certutil block, and the older spaced / colon-separated form', () => {
    expect(extractSha256(`SHA256 hash of C:\\Users\\a\\resume.pdf:\n${h}\nCertUtil: -hashfile command completed successfully.`)).toBe(h)
    expect(extractSha256(h.match(/../g).join(' '))).toBe(h)
    expect(extractSha256(h.match(/../g).join(':'))).toBe(h)
  })
  it('refuses anything that is not exactly one SHA-256', () => {
    expect(extractSha256('')).toBeNull(); expect(extractSha256('abc')).toBeNull()
    expect(extractSha256(h + 'a')).toBeNull()                       // 65 characters
    expect(extractSha256(`${h} ${'cd'.repeat(32)}`)).toBeNull()      // two different hashes: do not guess
  })
})

describe('G2: paste a fingerprint you computed yourself', () => {
  it('recognises the CURRENT fingerprint', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    fireEvent.change(await screen.findByLabelText(/paste a sha-256 fingerprint/i), { target: { value: `${CUR_PDF}  resume.pdf` } })
    fireEvent.click(screen.getByRole('button', { name: /check fingerprint/i }))
    expect((await screen.findByRole('status')).textContent).toMatch(/current, unmodified file/i)
  })
  it('recognises an EARLIER version — the thing comparing by eye cannot do', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    fireEvent.change(await screen.findByLabelText(/paste a sha-256 fingerprint/i), { target: { value: OLD_DOCX } })
    fireEvent.click(screen.getByRole('button', { name: /check fingerprint/i }))
    expect((await screen.findByRole('status')).textContent).toMatch(/matches an earlier \.docx, current until/i)
  })
  it('says what is wrong with something that is not a fingerprint, and shows no verdict', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    fireEvent.change(await screen.findByLabelText(/paste a sha-256 fingerprint/i), { target: { value: 'not a hash' } })
    fireEvent.click(screen.getByRole('button', { name: /check fingerprint/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/64 characters/i)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('a hash that matches nothing is the careful "not an exact copy" wording, not an accusation', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    fireEvent.change(await screen.findByLabelText(/paste a sha-256 fingerprint/i), { target: { value: 'e'.repeat(64) } })
    fireEvent.click(screen.getByRole('button', { name: /check fingerprint/i }))
    const text = (await screen.findByRole('status')).textContent
    expect(text).toMatch(/isn't an exact copy/i); expect(text).not.toMatch(/tamper(ed)? with\b(?! either)/i)
  })
})

describe('G4: several files can be checked together', () => {
  it('the input accepts several files and each gets its own named verdict', async () => {
    const docx = mkFile('word bytes', 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    const pdf = mkFile('pdf bytes', 'resume.pdf', 'application/pdf')
    // make the PDF "current" by serving its real digest as the page's pdf fingerprint
    api.get.mockResolvedValue(page({ fingerprints: { docx: CUR_DOCX, pdf: await sha(pdf), previous: [] } }))
    renderPage()
    const input = await screen.findByLabelText(/choose the \.docx or \.pdf you were sent/i)
    expect(input.multiple).toBe(true)
    fireEvent.change(input, { target: { files: [docx, pdf] } })
    // (the spinner is a role=status too while the files are read, so look for the results list itself)
    await waitFor(() => expect(document.querySelectorAll('ul[role="status"] li')).toHaveLength(2))
    const items = [...document.querySelectorAll('ul[role="status"] li')]
    expect(items[0].textContent).toMatch(/resume\.docx/); expect(items[0].textContent).toMatch(/isn't an exact copy/i)
    expect(items[1].textContent).toMatch(/resume\.pdf/); expect(items[1].textContent).toMatch(/current, unmodified file/i)
  })
  it('a file over the size cap is reported, without hashing it', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: 26 * 1024 * 1024 })
    fireEvent.change(await screen.findByLabelText(/choose the \.docx or \.pdf you were sent/i), { target: { files: [big] } })
    expect((await screen.findByRole('status')).textContent).toMatch(/too large to be a resume/i)
  })
})

describe('B5: a matching file under a headline that says the stored copy is not fine', () => {
  async function matchOn(over) {
    api.get.mockResolvedValue(page(over))
    renderPage()
    fireEvent.change(await screen.findByLabelText(/paste a sha-256 fingerprint/i), { target: { value: CUR_DOCX } })
    fireEvent.click(screen.getByRole('button', { name: /check fingerprint/i }))
    return (await screen.findByRole('status')).textContent
  }
  it('says the two are about different things when the stored copy is modified / missing / partial', async () => {
    for (const integrityStatus of ['modified', 'missing', 'partial']) {
      cleanup()
      const text = await matchOn({ verified: false, integrityStatus })
      expect(text).toMatch(/current, unmodified file/i)
      expect(text).toMatch(/not a full pass/i); expect(text).toMatch(/not about your file/i)
    }
  })
  it('adds nothing when the page itself is a clean pass', async () => {
    expect(await matchOn({})).not.toMatch(/not a full pass/i)
  })
})

describe('gap: when the integrity verdict was made', () => {
  it('shows a "Checked …" time in the Integrity tile', async () => {
    api.get.mockResolvedValue(page())
    renderPage()
    const tile = (await screen.findByText('Integrity')).parentElement
    expect(tile.textContent).toMatch(/Checked \d{1,2}:\d{2}/)
  })
  it('shows no time when the server did not send one (an entry cached before this round)', async () => {
    api.get.mockResolvedValue(page({ integrityCheckedAt: null }))
    renderPage()
    const tile = (await screen.findByText('Integrity')).parentElement
    expect(tile.textContent).not.toMatch(/Checked/)
  })
})
