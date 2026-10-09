// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn() }, getErrorMessage: (e, f) => f }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => <nav /> }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../../src/lib/fileFingerprint', async () => {
  const actual = await vi.importActual('../../src/lib/fileFingerprint')
  return { ...actual, sha256Hex: vi.fn(async () => 'f'.repeat(64)) }
})
import api from '../../src/lib/api'
import VerifyLookup from '../../src/pages/VerifyLookup'

function Landing() {
  const loc = useLocation()
  return <div data-testid="landing">{loc.pathname}|{JSON.stringify(loc.state)}</div>
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/check']}>
      <Routes>
        <Route path="/check" element={<VerifyLookup />} />
        <Route path="/v/:code" element={<Landing />} />
      </Routes>
    </MemoryRouter>)
}
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('VerifyLookup — look up by link or code (round 5, G2)', () => {
  it('a pasted verification link opens that page', async () => {
    renderPage()
    await userEvent.setup().type(screen.getByLabelText(/verification link or code/i), 'https://passthrough.dev/v/ab3xy7k2pq')
    await userEvent.setup().click(screen.getByRole('button', { name: /open page/i }))
    expect((await screen.findByTestId('landing')).textContent).toMatch(/^\/v\/AB3XY7K2PQ\|/)
    expect(api.get).not.toHaveBeenCalled()   // no API round trip for a typed code: the page itself answers
  })

  it('a code typed off a printed resume opens that page', async () => {
    renderPage()
    await userEvent.setup().type(screen.getByLabelText(/verification link or code/i), 'AB3XY-7K2PQ{enter}')
    expect((await screen.findByTestId('landing')).textContent).toMatch(/^\/v\/AB3XY7K2PQ\|/)
  })

  it('something that cannot be a code is explained and goes nowhere', async () => {
    renderPage()
    await userEvent.setup().type(screen.getByLabelText(/verification link or code/i), 'hello{enter}')
    expect((await screen.findByRole('alert')).textContent).toMatch(/doesn't look like a passthrough verification link or code/i)
    expect(screen.queryByTestId('landing')).toBeNull()
  })

  it('the error clears as soon as the reader edits the field', async () => {
    renderPage()
    const u = userEvent.setup()
    await u.type(screen.getByLabelText(/verification link or code/i), 'x{enter}')
    await screen.findByRole('alert')
    await u.type(screen.getByLabelText(/verification link or code/i), 'y')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('both file inputs are labelled for screen readers', () => {
    renderPage()
    expect(screen.getByLabelText(/choose the \.docx or \.pdf you were sent/i)).toBeInTheDocument()
  })
})

describe('VerifyLookup — the file lookup hands the match to the page (round 5, G1)', () => {
  it('navigates with { code, hash, kind } so the page can say how THIS file relates to it', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { code: 'AB3XY7K2PQ', match: 'previous', kind: 'docx' } } })
    renderPage()
    const file = new File(['x'], 'Ada Resume.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    fireEvent.change(screen.getByLabelText(/choose the \.docx or \.pdf you were sent/i), { target: { files: [file] } })
    const landing = await screen.findByTestId('landing')
    const [path, state] = landing.textContent.split('|')
    expect(path).toBe('/v/AB3XY7K2PQ')
    expect(JSON.parse(state)).toEqual({ fileCheck: { code: 'AB3XY7K2PQ', hash: 'f'.repeat(64), kind: 'docx' } })
    expect(api.get).toHaveBeenCalledWith(`/verify/by-hash/${'f'.repeat(64)}`)
  })

  it('a 404 is still the "no match" message', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 404 } }))
    renderPage()
    fireEvent.change(screen.getByLabelText(/choose the \.docx or \.pdf you were sent/i), { target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/no passthrough verification matches that exact file/i))
  })
})
