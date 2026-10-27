// Experts Phase 0A: the Human rewrite fake door on the offer card. Flag OFF = the card is as it always was; flag ON = a secondary
// option, an honest modal, a waitlist, and events that carry no resume text or contact detail.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import FixBanner from '../../src/components/scan/FixBanner'
import { AuthContext } from '../../src/context/AuthContext'
import { resetHumanDemandCache, getVisitorId } from '../../src/lib/humanDemand'

const PRICES = { FIX: { amount: 2900, originalAmount: 4900 }, FIX_PLAIN: { amount: 1900, originalAmount: 3900 }, BADGE: { amount: 900, originalAmount: 3900 } }
vi.mock('../../src/hooks/usePricing', async orig => ({
  ...(await orig()),
  usePricing: () => ({ byTier: t => PRICES[t], pricing: { currency: 'USD' }, pricingFailed: false, refresh: vi.fn(), clockOffsetMs: 0 }),
}))
vi.mock('../../src/components/ui/ReferralCodeEntry', () => ({ ReferralCodeEntry: () => null, PricingFailedNotice: () => null }))

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('../../src/lib/api', () => ({ default: api, getErrorMessage: (e, d) => e?.response?.data?.message || d }))

const TABLES = {
  low:  { polish: 4900, seven_day: 7900, forty_eight_hour: 9900,  twenty_four_hour: 12900, cover_letter: 2500 },
  base: { polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 },
  high: { polish: 6900, seven_day: 9900, forty_eight_hour: 13900, twenty_four_hour: 17900, cover_letter: 3900 },
}
const flagOn = (variant = 'base') => api.get.mockResolvedValue({ data: { success: true, data: { variant, currency: 'USD', prices: TABLES[variant], tiers: [] } } })
const flagOff = () => api.get.mockRejectedValue({ response: { status: 404, data: { success: false, message: 'Not found.' } } })

const scan = { id: 's1', status: 'COMPLETE_FAIL', fixPurchased: false, atsScore: 52, badgeEligible: false, inputMode: 'text' }
const show = (user = null) => render(
  <AuthContext.Provider value={{ user }}><FixBanner scan={scan} onPay={vi.fn()} onRedeemCredit={vi.fn()} /></AuthContext.Provider>)
const eventCalls = () => api.post.mock.calls.filter(c => c[0] === '/human-demand/events').map(c => c[1])

beforeEach(() => {
  vi.clearAllMocks(); resetHumanDemandCache(); window.localStorage.clear(); window.sessionStorage.clear()
  api.post.mockResolvedValue({ data: { success: true, data: { joined: true, alreadyOnList: false } } })
})

describe('flag OFF', () => {
  it('the offer card is untouched: no Human option, no Human wording, no event or waitlist call', async () => {
    flagOff()
    show()
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 20))
    const card = screen.getByTestId('offer-card')
    expect(within(card).queryByTestId('human-rewrite-option')).toBeNull()
    expect(card.textContent).not.toMatch(/human/i)
    expect(screen.getByRole('button', { name: /Fix & verify my resume/ })).toBeInTheDocument()
    expect(within(screen.getByTestId('alt-plain')).getByRole('button')).toHaveTextContent('$19')
    expect(api.post).not.toHaveBeenCalled()
  })
  it('asks the server once per tab session, then remembers "off"', async () => {
    flagOff()
    const first = show(); await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1)); first.unmount()
    resetHumanDemandCacheMemoryOnly()
    show(); await new Promise(r => setTimeout(r, 20))
    expect(api.get).toHaveBeenCalledTimes(1)
  })
  it('a failed request (network / 5xx) shows nothing and is not remembered as "off"', async () => {
    api.get.mockRejectedValue(new Error('Network Error'))
    show(); await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByTestId('human-rewrite-option')).toBeNull()
    expect(window.sessionStorage.getItem('pt_hd_cfg')).toBeNull()
  })
})
function resetHumanDemandCacheMemoryOnly() { /* the module cache is kept on purpose; sessionStorage also holds the answer */ }

describe('flag ON', () => {
  it('adds a SECONDARY button beside the AI Fix, which stays the main button', async () => {
    flagOn()
    show()
    const opt = await screen.findByTestId('human-rewrite-option')
    expect(opt).toHaveTextContent('Human options from $59')
    expect(opt).toHaveTextContent(/opening soon/i)
    expect(screen.getByRole('button', { name: /Fix & verify my resume/ })).toBeInTheDocument()
    expect(screen.getByTestId('alt-plain')).toBeInTheDocument()
    expect(within(screen.getByTestId('offer-card')).getByTestId('human-rewrite-button')).toHaveTextContent('Human rewrite')
  })

  it('records "button shown" once, with only the event name and the visitor id', async () => {
    flagOn()
    show(); await screen.findByTestId('human-rewrite-option')
    await waitFor(() => expect(eventCalls()).toHaveLength(1))
    expect(eventCalls()[0]).toEqual({ event: 'button_shown', visitorId: getVisitorId() })
  })

  for (const variant of ['low', 'base', 'high']) {
    it(`variant "${variant}": the modal lists the ladder with that variant's prices and the cover letter add-on`, async () => {
      flagOn(variant)
      show(); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
      for (const t of ['polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour'])
        expect(screen.getByTestId(`price-${t}`)).toHaveTextContent(`$${TABLES[variant][t] / 100}`)
      expect(screen.getByTestId('price-cover_letter')).toHaveTextContent(`+$${TABLES[variant].cover_letter / 100}`)
      expect(screen.getByText('Human polish')).toBeInTheDocument()
      expect(screen.getByText('Human rewrite, 7 days')).toBeInTheDocument()
      expect(screen.getByText('Human rewrite, 48 hours')).toBeInTheDocument()
      expect(screen.getByText('Human rewrite, 24 hours')).toBeInTheDocument()
    })
  }

  it('the visitor id is kept, so the same browser asks for the same variant every visit', async () => {
    flagOn(); show(); await screen.findByTestId('human-rewrite-option')
    const id1 = api.get.mock.calls[0][1].params.vid
    expect(id1).toMatch(/^[a-f0-9]{32}$/)
    expect(window.localStorage.getItem('pt_hd_vid')).toBe(id1)
    expect(getVisitorId()).toBe(id1)
  })

  it('the copy is honest: opening soon, free, no payment, expected prices, privacy line; no scarcity, countdown or live claims', async () => {
    flagOn(); show(); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    const dlg = screen.getByRole('dialog')
    expect(dlg).toHaveTextContent(/opening this soon and it is not available yet/i)
    expect(dlg).toHaveTextContent(/free and no payment is taken/i)
    expect(dlg).toHaveTextContent(/prices below are what we expect to charge at launch/i)
    expect(screen.getByTestId('human-privacy-line')).toHaveTextContent('When this opens, a human expert will see your resume. Your contact details will be hidden while they work.')
    expect(dlg.textContent).not.toMatch(/limited|spots? left|only \d|hurry|countdown|expires|ends (in|soon)|available now|order now|buy now|pay now|checkout|most popular|best value|sold out|now live|discount|promo|code/i)
    expect(screen.queryByTestId('offer-countdown')).toBeNull()
    for (const r of screen.getAllByRole('radio')) expect(r).not.toBeChecked()                // nothing pre-selected
    expect(screen.getByRole('checkbox', { name: /cover letter/i })).not.toBeChecked()        // not pre-ticked
  })

  it('records clicked, tier selected, cover letter toggled and dismissed, each with the tier where there is one', async () => {
    flagOn(); show(); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    fireEvent.click(screen.getByRole('radio', { name: /Human rewrite, 48 hours/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /cover letter/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /cover letter/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(eventCalls().map(e => e.event)).toEqual(['button_shown', 'button_clicked', 'tier_selected', 'cover_letter_toggled', 'cover_letter_toggled', 'modal_dismissed']))
    const ev = eventCalls()
    expect(ev[2]).toMatchObject({ tier: 'forty_eight_hour' })
    expect(ev[3]).toMatchObject({ coverLetter: true, tier: 'forty_eight_hour' })
    expect(ev[4]).toMatchObject({ coverLetter: false })
    expect(ev[5]).toMatchObject({ tier: 'forty_eight_hour' })
    // nothing but these keys ever leaves the browser in an event
    for (const e of ev) for (const k of Object.keys(e)) expect(['event', 'visitorId', 'tier', 'coverLetter']).toContain(k)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a visitor with no account must give an email and tick the box; then joins, and the request carries exactly what they chose', async () => {
    flagOn('high'); show(); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose an option/)
    fireEvent.click(screen.getByRole('radio', { name: /Human polish/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/email/i)
    fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'jane@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Tick the box/)
    fireEvent.click(screen.getByRole('checkbox', { name: /Email me when/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /cover letter/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    const done = await screen.findByTestId('human-waitlist-done')
    expect(done).toHaveTextContent(/on the waitlist/i)
    expect(done).toHaveTextContent(/No payment was taken/)
    expect(done).toHaveTextContent(/We will email you when Human rewrite opens/)
    const call = api.post.mock.calls.find(c => c[0] === '/human-demand/waitlist')
    expect(call[1]).toEqual({ visitorId: getVisitorId(), tier: 'polish', coverLetter: true, consent: true, email: 'jane@example.com' })   // no price: the server decides it
    // closing after joining is not a "dismissal"
    fireEvent.click(within(done).getByRole('button', { name: 'Close' }))
    await new Promise(r => setTimeout(r, 20))
    expect(eventCalls().some(e => e.event === 'modal_dismissed')).toBe(false)
    // and the email never rode along in any event
    expect(JSON.stringify(eventCalls())).not.toMatch(/jane|@/)
  })

  it('a signed-in visitor is not asked for an email, and may join without ticking the email box (then is told we will not email)', async () => {
    flagOn(); show({ id: 'u1', email: 'me@example.com' }); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    expect(screen.queryByLabelText('Your email')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /7 days/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    const done = await screen.findByTestId('human-waitlist-done')
    expect(done).toHaveTextContent(/will not email you/)
    const body = api.post.mock.calls.find(c => c[0] === '/human-demand/waitlist')[1]
    expect(body).toEqual({ visitorId: getVisitorId(), tier: 'seven_day', coverLetter: false, consent: false })
    expect(JSON.stringify(body)).not.toMatch(/me@example/)
  })

  it('shows the server\'s message and keeps the form when joining fails', async () => {
    flagOn(); show({ id: 'u1' }); fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    api.post.mockImplementation(async url => { if (url === '/human-demand/waitlist') throw { response: { data: { message: 'Too many attempts. Please wait a while and try again.' } } }; return { data: {} } })
    fireEvent.click(screen.getByRole('radio', { name: /Human polish/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
    expect(screen.getByTestId('human-waitlist-form')).toBeInTheDocument()
  })

  it('never touches checkout: the AI Fix buttons are not called by anything in the Human flow', async () => {
    flagOn()
    const onPay = vi.fn()
    render(<AuthContext.Provider value={{ user: { id: 'u1' } }}><FixBanner scan={scan} onPay={onPay} onRedeemCredit={vi.fn()} /></AuthContext.Provider>)
    fireEvent.click(await screen.findByTestId('human-rewrite-button'))
    fireEvent.click(screen.getByRole('radio', { name: /Human polish/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Join the waitlist' }))
    await screen.findByTestId('human-waitlist-done')
    expect(onPay).not.toHaveBeenCalled()
    for (const c of api.post.mock.calls) expect(c[0]).toMatch(/^\/human-demand\//)
    for (const c of api.get.mock.calls) expect(c[0]).toMatch(/^\/human-demand\//)
  })
})
