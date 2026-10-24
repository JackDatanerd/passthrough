import Button from '../ui/Button'
import CopyButton from '../ui/CopyButton'
import { fmtPrice } from '../../hooks/usePricing'
import { formatMonthDay } from '../../lib/utils'

// The account's personal welcome offer (hooks/useWelcomeOffer), shown on the dashboard so a new account sees it without having to
// find the email. The code is applied for them at checkout (it belongs to this account alone), so the card says that first and
// shows the code only as a reference they can copy. Renders nothing when there is no offer.
export default function WelcomeOfferCard({ offer, onScan }) {
  if (!offer) return null
  const expires = new Date(offer.expiresAt)
  const days = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / 86400000))
  const left = days <= 1 ? 'Ends today or tomorrow' : `${days} days left`
  return (
    <section aria-label="Welcome offer" data-testid="welcome-offer-card"
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-emerald-900">{offer.percentOff}% off your first full fix</h2>
        <p className="text-sm text-emerald-900/80 mt-0.5">
          Full fix + Verified credential for {fmtPrice(offer.amountCents, offer.currency)} instead of {fmtPrice(offer.listAmountCents, offer.currency)}.
          It is applied for you at checkout, and it works once.
        </p>
        <p className="text-xs text-emerald-900/70 mt-1">
          Expires {formatMonthDay(expires) ?? '—'} · {left}
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end shrink-0">
        <div className="flex items-center gap-2">
          <code className="rounded border border-emerald-200 bg-white px-2 py-1 text-sm font-semibold tracking-wide text-emerald-900" data-testid="welcome-offer-code">{offer.code}</code>
          <CopyButton text={offer.code} label="Copy" copiedLabel="Copied ✓" />
        </div>
        {onScan && <Button size="sm" onClick={onScan}>Scan a resume</Button>}
      </div>
    </section>
  )
}
