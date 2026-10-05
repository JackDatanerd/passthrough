// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import PartnerApply from '../../src/pages/PartnerApply'

// api.post is a plain function, NOT a vi.fn(): vitest's spy wrapper keeps its own handle on the
// promise a mock returns, so a mock that rejects shows up as an "unhandled rejection" on the test
// even though the page handles it. Calls are recorded by hand instead.
const h = vi.hoisted(() => ({ calls: [], impl: null }))
vi.mock('../../src/lib/api', () => ({
  default: { post: (...args) => { h.calls.push(args); return h.impl(...args) } },
  getErrorMessage: (e, f) => e?.response?.data?.message || e?.message || f,
}))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const renderIt = () => render(<MemoryRouter><PartnerApply /></MemoryRouter>)
const fill = async () => {
  await userEvent.type(screen.getByLabelText('Your name'), '  Ann Coach ')
  await userEvent.type(screen.getByLabelText('Email'), 'ann@x.co')
}
const submit = () => userEvent.click(screen.getByRole('button', { name: /submit application/i }))
beforeEach(() => { h.calls.length = 0; h.impl = () => Promise.resolve({ data: { success: true } }) })

describe('PartnerApply', () => {
  it('requires a name and an email before calling the API', async () => {
    renderIt()
    await submit()
    expect(await screen.findByText(/enter your name and email/i)).toBeInTheDocument()
    expect(h.calls).toHaveLength(0)
  })

  it('posts only the fields that were filled in (never the empty honeypot) then shows the thank-you state', async () => {
    renderIt()
    await fill()
    await submit()
    expect(await screen.findByText(/application received/i)).toBeInTheDocument()
    expect(h.calls).toEqual([['/partners/apply', { name: 'Ann Coach', email: 'ann@x.co' }]])
  })

  it('shows the server error and stays on the form', async () => {
    h.impl = () => Promise.reject({ response: { status: 429, data: { message: 'Too many attempts. Please wait a few minutes.' } } })
    renderIt()
    await fill()
    await submit()
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument()
    expect(screen.queryByText(/application received/i)).toBeNull()
  })
})
