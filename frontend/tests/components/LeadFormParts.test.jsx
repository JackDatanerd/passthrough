// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LeadConsentNote, LEAD_SENT_MESSAGE } from '../../src/components/lead/LeadFormParts'

describe('lead form copy (B4)', () => {
  it('the success message does not promise an email — none is sent for a known, removed or just-mailed address', () => {
    expect(LEAD_SENT_MESSAGE).toMatch(/if this address isn't already on our list/i)
    expect(LEAD_SENT_MESSAGE).not.toMatch(/^Almost there/)
  })
  it('the consent note says a confirmation is sent only when the address is new', () => {
    render(<MemoryRouter><LeadConsentNote /></MemoryRouter>)
    expect(screen.getByText(/If this address is new to us/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
  })
})
