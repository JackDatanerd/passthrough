// @vitest-environment jsdom
// Section 4 round 7 (feature gap): "I lost my link".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import PartnerRecover from '../../src/pages/PartnerRecover'

const h = vi.hoisted(() => ({ calls: [], impl: null }))
vi.mock('../../src/lib/api', () => ({
  default: { post: (...args) => { h.calls.push(args); return h.impl(...args) } },
  getErrorMessage: (e, f) => e?.response?.data?.message || e?.message || f,
}))
vi.mock('../../src/components/layout/Navbar', () => ({ default: () => null }))
vi.mock('../../src/components/layout/Footer', () => ({ default: () => null }))

const renderIt = () => render(<MemoryRouter><PartnerRecover /></MemoryRouter>)
beforeEach(() => { h.calls.length = 0; h.impl = () => Promise.resolve({ data: { success: true } }) })

describe('PartnerRecover', () => {
  it('needs an email before calling the API', async () => {
    renderIt()
    await userEvent.click(screen.getByRole('button', { name: /email me my link/i }))
    expect(await screen.findByText(/enter your email/i)).toBeInTheDocument()
    expect(h.calls).toHaveLength(0)
  })

  it('posts the trimmed email (never the empty honeypot) and shows the same neutral confirmation', async () => {
    renderIt()
    await userEvent.type(screen.getByLabelText('Email'), '  k@x.co ')
    await userEvent.click(screen.getByRole('button', { name: /email me my link/i }))
    expect(await screen.findByTestId('recover-sent')).toHaveTextContent(/if k@x\.co belongs to a passthrough partner/i)
    expect(h.calls).toEqual([['/partners/recover-links', { email: 'k@x.co' }]])
  })

  it('shows the server error (e.g. rate limit) and stays on the form', async () => {
    h.impl = () => Promise.reject({ response: { status: 429, data: { message: 'Too many requests. Please wait a few minutes.' } } })
    renderIt()
    await userEvent.type(screen.getByLabelText('Email'), 'k@x.co')
    await userEvent.click(screen.getByRole('button', { name: /email me my link/i }))
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument()
    expect(screen.queryByTestId('recover-sent')).toBeNull()
  })
})
