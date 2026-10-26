import { useContext, useEffect, useRef, useState } from 'react'
import Button from '../ui/Button'
import Modal from '../ui/Modal'
import Radio from '../ui/Radio'
import Checkbox from '../ui/Checkbox'
import Input from '../ui/Input'
import { AuthContext } from '../../context/AuthContext'
import { fmtPrice } from '../../hooks/usePricing'
import { getErrorMessage } from '../../lib/api'
import {
  TIERS, TIER_LABELS, TIER_NOTES, loadHumanDemandConfig, trackHumanDemand, joinHumanWaitlist,
} from '../../lib/humanDemand'

// Passthrough Experts, Phase 0A: a fake-door "Human rewrite" option on the offer card. A SECONDARY option beside the AI Fix; it
// never replaces it and never takes a payment. It renders NOTHING unless the server's HUMAN_DEMAND_ENABLED flag is on.
//
// Honest by construction: it says this is opening soon, joining is free, no payment is taken, and the prices are the expected launch
// prices. No countdown, no scarcity, no "most popular", no pre-selected tier, and no claim that the service is live.
// No discount, promo, welcome or referral code is read or applied here.

const PRIVACY_LINE = 'A human expert will see your resume; your contact details stay hidden while they work.'

export default function HumanRewriteOption() {
  const user = useContext(AuthContext)?.user || null       // null-safe on purpose: the offer card renders in bare tests too
  const [config, setConfig] = useState(null)
  const [open, setOpen] = useState(false)
  const [tier, setTier] = useState('')
  const [coverLetter, setCoverLetter] = useState(false)
  const [email, setEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null)               // { consent } once joined
  const shownRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    loadHumanDemandConfig().then(c => { if (!cancelled) setConfig(c) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (config && !shownRef.current) { shownRef.current = true; trackHumanDemand('button_shown') }
  }, [config])

  if (!config) return null

  const money = cents => fmtPrice(cents, config.currency || 'USD')
  const prices = config.prices
  const signedIn = !!user?.id

  const openModal = () => { setOpen(true); trackHumanDemand('button_clicked') }
  const closeModal = () => {
    setOpen(false)
    if (!done) trackHumanDemand('modal_dismissed', { tier: tier || undefined })
  }
  const pickTier = t => { setTier(t); setError(''); trackHumanDemand('tier_selected', { tier: t }) }
  const toggleCover = on => { setCoverLetter(on); trackHumanDemand('cover_letter_toggled', { coverLetter: on, tier: tier || undefined }) }

  const submit = async e => {
    e.preventDefault()
    if (busy) return
    if (!tier) { setError('Choose an option first.'); return }
    if (!signedIn && !email.trim()) { setError('Enter the email we should write to.'); return }
    if (!signedIn && !consent) { setError('Tick the box to say we may email you when this opens.'); return }
    setBusy(true); setError('')
    try {
      await joinHumanWaitlist({ tier, coverLetter, consent, email: signedIn ? '' : email.trim() })
      setDone({ consent })
    } catch (err) {
      setError(getErrorMessage(err, 'We could not add you just now. Please try again.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5" data-testid="human-rewrite-option">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
        <span>Want a person to do it?<span className="block text-xs text-gray-500">Human options from {money(prices.polish)}. Opening soon.</span></span>
        <Button type="button" variant="secondary" onClick={openModal} data-testid="human-rewrite-button">Human rewrite</Button>
      </div>

      <Modal open={open} onClose={closeModal} title="Human rewrite: opening soon" dismissible={!busy}>
        {done ? (
          <div data-testid="human-waitlist-done" role="status">
            <p className="text-sm text-gray-800"><b>You are on the waitlist.</b> No payment was taken.</p>
            <p className="mt-2 text-sm text-gray-600">
              {done.consent ? 'We will email you when Human rewrite opens.' : 'You did not tick the email box, so we will not email you. Your interest is noted.'}
            </p>
            <Button type="button" className="mt-4" onClick={closeModal}>Close</Button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate data-testid="human-waitlist-form">
            <p className="text-sm text-gray-700" data-testid="human-honest-copy">
              We are opening this soon and it is not available yet. Joining the waitlist is free and no payment is taken.
              The prices below are what we expect to charge at launch.
            </p>
            <fieldset className="mt-3">
              <legend className="text-sm font-semibold text-gray-900">Which would you want?</legend>
              <div className="mt-2 grid gap-2">
                {TIERS.map(t => (
                  <Radio key={t} name="human-tier" value={t} checked={tier === t} onChange={() => pickTier(t)}
                    wrapperClassName={`flex w-full rounded-lg border px-3 py-2 ${tier === t ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}
                    label={<span className="flex justify-between gap-4 font-medium text-gray-900"><span>{TIER_LABELS[t]}</span><span data-testid={`price-${t}`}>{money(prices[t])}</span></span>}
                    description={TIER_NOTES[t]} />
                ))}
              </div>
            </fieldset>
            <Checkbox wrapperClassName="mt-3" alignTop checked={coverLetter} onChange={e => toggleCover(e.target.checked)}
              label={<span>Add a tailored cover letter <b data-testid="price-cover_letter">+{money(prices.cover_letter)}</b></span>} />

            {!signedIn && (
              <Input wrapperClassName="mt-3" label="Your email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" maxLength={254} />
            )}
            <Checkbox wrapperClassName="mt-3" alignTop checked={consent} onChange={e => setConsent(e.target.checked)}
              label={`Email me when Human rewrite opens.${signedIn ? ' We will use your account email.' : ''}`} />

            <p className="mt-3 text-xs text-gray-600" data-testid="human-privacy-line">{PRIVACY_LINE}</p>
            {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={busy}>Join the waitlist</Button>
              <Button type="button" variant="secondary" onClick={closeModal} disabled={busy}>Not now</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  )
}
