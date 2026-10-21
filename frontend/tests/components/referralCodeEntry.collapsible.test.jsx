// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReferralCodeEntry } from '../../src/components/ui/ReferralCodeEntry'

// The checkout offer collapses the empty code box (an open coupon field invites people to leave and hunt for a code);
// the Pricing page keeps it open, and a code that is already applied always shows its confirmation.
describe('ReferralCodeEntry — collapsible', () => {
  it('starts as a "Have a code?" link and opens the field on click', async () => {
    const user = userEvent.setup()
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={vi.fn()} collapsible />)
    expect(screen.queryByLabelText('Referral code')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Have a code?' }))
    expect(screen.getByLabelText('Referral code')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Have a code?' })).toBeNull()
  })

  it('a code typed after opening can be applied', async () => {
    const user = userEvent.setup(); const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={onApply} collapsible />)
    await user.click(screen.getByRole('button', { name: 'Have a code?' }))
    await user.type(screen.getByLabelText('Referral code'), 'abc12')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith('abc12')
  })

  it('shows the field open by default (the Pricing page)', () => {
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={vi.fn()} />)
    expect(screen.getByLabelText('Referral code')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Have a code?' })).toBeNull()
  })

  it('an applied code is confirmed, never hidden behind the link', () => {
    render(<ReferralCodeEntry referralCode="PARTNER10" pricing={{ referralApplied: true, discountApplied: true }} onApply={vi.fn()} collapsible />)
    expect(screen.getByRole('status')).toHaveTextContent(/PARTNER10.*applied/)
    expect(screen.queryByRole('button', { name: 'Have a code?' })).toBeNull()
  })

  it('a pre-filled code that pricing rejects still shows the field and its error', () => {
    render(<ReferralCodeEntry referralCode="STALE" pricing={{ referralApplied: false }} onApply={vi.fn()} collapsible />)
    expect(screen.getByLabelText('Referral code')).toHaveValue('STALE')
    expect(screen.getByText(/doesn't look right/)).toBeInTheDocument()
  })
})
