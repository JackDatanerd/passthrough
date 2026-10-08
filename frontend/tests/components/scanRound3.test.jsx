// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import FixBanner from '../../src/components/scan/FixBanner'
import DiffView from '../../src/components/scan/DiffView'
import JobDescriptionPanel from '../../src/components/scan/JobDescriptionPanel'
import AtsDetailPanel from '../../src/components/scan/AtsDetailPanel'

// Scan / ATS round 3 — the UI half of G2 / G3 / G5 / G7.
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: () => ({ byTier: () => ({ amount: 3900, originalAmount: 3900 }), pricing: { currency: 'USD' }, pricingFailed: false, refresh: vi.fn() }),
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: () => null, PricingFailedNotice: () => null }))

const renderBanner = props => render(<MemoryRouter><FixBanner onPay={vi.fn()} onRedeemCredit={vi.fn()} {...props} /></MemoryRouter>)
const eligible = over => ({ id: 's1', status: 'COMPLETE_PASS', fixPurchased: false, atsScore: 86, badgeEligible: true, ...over })
const badgeBtn = () => screen.queryByRole('button', { name: /Verified Credential only/ })

describe('FixBanner — the Badge is only offered on a file that would actually be verified (G2)', () => {
  it('an uploaded file with no formatted score yet: no Credential-only button, a check button instead', async () => {
    const user = userEvent.setup(); const onCheckFormatted = vi.fn()
    renderBanner({ scan: eligible({ inputMode: 'file', atsDetail: {} }), onCheckFormatted })
    expect(badgeBtn()).not.toBeInTheDocument()
    expect(screen.getByTestId('formatted-check')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check the formatted file' }))
    expect(onCheckFormatted).toHaveBeenCalledTimes(1)
    // the other purchases are not held hostage by the check
    expect(screen.getByRole('button', { name: /Full AI Fix \+ Credential/ })).toBeInTheDocument()
  })
  it('a formatted file under the bar: the Badge is withheld and the number is explained', () => {
    renderBanner({ scan: eligible({ inputMode: 'file', atsDetail: { formattedScore: 71 } }) })
    expect(badgeBtn()).not.toBeInTheDocument()
    expect(screen.getByTestId('formatted-low')).toHaveTextContent('71')
    expect(screen.getByRole('button', { name: /Full AI Fix \+ Credential/ })).toBeInTheDocument()
  })
  it('a formatted file over the bar: the Badge is offered, with the score shown', () => {
    renderBanner({ scan: eligible({ inputMode: 'file', atsDetail: { formattedScore: 84 } }) })
    expect(badgeBtn()).toBeInTheDocument()
    expect(screen.getByTestId('formatted-ok')).toHaveTextContent('84')
  })
  it('typed / saved-profile scans are already scored on the rendered document: nothing changes', () => {
    renderBanner({ scan: eligible({ inputMode: 'brain_dump', atsDetail: {} }) })
    expect(badgeBtn()).toBeInTheDocument()
    expect(screen.queryByTestId('formatted-check')).not.toBeInTheDocument()
  })
  it('a failed check shows its reason', () => {
    renderBanner({ scan: eligible({ inputMode: 'file', atsDetail: {} }), onCheckFormatted: vi.fn(), checkFormattedError: 'We could not build it' })
    expect(screen.getByRole('alert')).toHaveTextContent('We could not build it')
  })
})

describe('DiffView — the owner\'s own edits are not blamed on the AI (G7)', () => {
  const original = { name: 'Jane', skills: ['Node.js'], experience: [] }
  const edited = { name: 'Jane', skills: ['Node.js', 'Redis'], experience: [] }
  it('unedited: the skills warning names the AI rewrite', async () => {
    const user = userEvent.setup()
    render(<DiffView originalResumeData={original} rewrittenResumeData={edited} fixTier="FIX" />)
    await user.click(screen.getByRole('button'))
    expect(screen.getByText(/introduced by the AI rewrite/)).toBeInTheDocument()
  })
  it('edited by the owner: it says it is their reviewed version, and a Badge edit is a diff, not "nothing changed"', async () => {
    const user = userEvent.setup()
    render(<DiffView originalResumeData={original} rewrittenResumeData={edited} fixTier="BADGE" editedByUser />)
    expect(screen.getByText(/version you edited/)).toBeInTheDocument()
    expect(screen.queryByText(/nothing was rewritten/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(screen.getByText(/the version you reviewed and saved/)).toBeInTheDocument()
    expect(screen.queryByText(/introduced by the AI rewrite/)).not.toBeInTheDocument()
  })
  it('a Badge nobody edited is still "credential only"', () => {
    render(<DiffView originalResumeData={original} rewrittenResumeData={null} fixTier="BADGE" />)
    expect(screen.getByText('What was verified')).toBeInTheDocument()
  })
})

describe('JobDescriptionPanel — the job we scored against is visible (G5)', () => {
  it('shows the scored text, title and source link', () => {
    render(<JobDescriptionPanel scan={{ jobDescriptionText: 'We need a backend engineer who knows Node.', jobTitle: 'Backend Engineer', jobDescriptionUrl: 'https://jobs.example.com/1' }} />)
    expect(screen.getByText(/We need a backend engineer/)).toBeInTheDocument()
    expect(screen.getByText(/Backend Engineer/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://jobs.example.com/1' })).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })
  it('never turns a non-http(s) URL into a link', () => {
    render(<JobDescriptionPanel scan={{ jobDescriptionText: 'text '.repeat(20), jobDescriptionUrl: 'javascript:alert(1)' }} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
  it('renders nothing without stored text', () => {
    const { container } = render(<JobDescriptionPanel scan={{ jobDescriptionText: '  ' }} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('AtsDetailPanel — can explain the delivered file too (G3)', () => {
  const detail = { keywords: { matched: ['node'], missing: ['kubernetes'] }, sections: { found: ['Experience'], missing: [] }, format: { issues: [] }, content: {}, aiMissingKeywords: [] }
  it('uses an explicit detail and title', () => {
    render(<AtsDetailPanel detail={detail} title="Why the new score" />)
    expect(screen.getByText('Why the new score')).toBeInTheDocument()
    expect(screen.getByText(/kubernetes/i)).toBeInTheDocument()
  })
  it('still defaults to the scan\'s own atsDetail and "Why this score"', () => {
    render(<AtsDetailPanel scan={{ atsDetail: detail }} />)
    expect(screen.getByText('Why this score')).toBeInTheDocument()
  })
})
