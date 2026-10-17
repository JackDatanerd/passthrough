// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getErrorMessage: (e, f) => e?.response?.data?.message || f }))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => <nav /> }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => <footer /> }))
vi.mock('../../src/components/lead/TurnstileWidget', () => ({ default: () => null, TURNSTILE_ENABLED: false }))
import api from '../../src/lib/api'
import Verify from '../../src/pages/Verify'

const CODE = 'AB3XY7K2PQ'
const page = () => ({ data: { success: true, data: {
  candidateFirstName: 'Ada', atsScore: 85, passed: true, verified: true, roleCategory: 'software_engineering', seniorityLevel: 'senior',
  verifiedAt: '2026-03-01T00:00:00.000Z', integrityStatus: 'verified', verificationViews: 3, exposeDocx: false, exposePdf: false,
  fingerprints: { docx: 'c'.repeat(64), pdf: null, previous: [] } } } })
const renderAt = () => render(
  <MemoryRouter initialEntries={[`/v/${CODE}`]}>
    <Routes><Route path="/v/:code" element={<Verify />} /></Routes>
  </MemoryRouter>)
beforeEach(() => { cleanup(); vi.clearAllMocks(); api.get.mockResolvedValue(page()) })

async function openForm() {
  renderAt()
  fireEvent.click(await screen.findByRole('button', { name: /report a problem with this page/i }))
  return screen.findByRole('button', { name: /send report/i })
}

describe('Verify — round 8: report a problem', () => {
  it('the link opens an in-page form (not a mailto) and keeps the mailto as a fallback', async () => {
    await openForm()
    expect(screen.getByLabelText(/what looks wrong/i)).toBeTruthy()
    const fallback = screen.getByRole('link', { name: /or email support/i })
    expect(fallback.getAttribute('href')).toMatch(/^mailto:support@usepassthrough\.com/)
  })
  it('asks for a reason before sending anything', async () => {
    const send = await openForm()
    fireEvent.click(send)
    expect((await screen.findByRole('alert')).textContent).toMatch(/choose what looks wrong/i)
    expect(api.post).not.toHaveBeenCalled()
  })
  it('posts the reason, note and e-mail to the page\'s report endpoint and confirms', async () => {
    api.post.mockResolvedValue({ data: { success: true, message: 'Thanks — your report was received and will be reviewed.' } })
    const send = await openForm()
    fireEvent.change(screen.getByLabelText(/what looks wrong/i), { target: { value: 'FAKE' } })
    fireEvent.change(screen.getByLabelText(/details/i), { target: { value: '  Not the person  ' } })
    fireEvent.change(screen.getByLabelText(/your e-mail/i), { target: { value: 'me@example.com' } })
    fireEvent.click(send)
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    expect(api.post).toHaveBeenCalledWith(`/verify/${CODE}/report`, { reason: 'FAKE', details: 'Not the person', email: 'me@example.com', trap: '', turnstileToken: undefined })
    expect((await screen.findByRole('status')).textContent).toMatch(/report was received/i)
  })
  it('a failure shows the server\'s message and leaves the form usable', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 429, data: { message: 'Too many reports from your network. Please wait a while.' } } }))
    const send = await openForm()
    fireEvent.change(screen.getByLabelText(/what looks wrong/i), { target: { value: 'OTHER' } })
    fireEvent.click(send)
    expect((await screen.findByRole('alert')).textContent).toMatch(/too many reports/i)
    expect(screen.getByRole('button', { name: /send report/i })).toBeTruthy()
  })
  it('the honeypot is hidden from people and assistive tech', async () => {
    await openForm()
    const trap = document.querySelector('input[name="report_ref_code"]')
    expect(trap).toBeTruthy()
    expect(trap.getAttribute('aria-hidden')).toBe('true')
    expect(trap.tabIndex).toBe(-1)
  })
  it('Cancel closes the form', async () => {
    await openForm()
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('button', { name: /send report/i })).toBeNull()
  })
})
