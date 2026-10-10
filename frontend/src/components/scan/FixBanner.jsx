import Button from '../ui/Button'
import PromoCountdown from '../ui/PromoCountdown'
import { usePricing, fmtPrice } from '../../hooks/usePricing'
import { ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES } from '../../lib/scoreThresholds'
import { ReferralCodeEntry, PricingFailedNotice } from '../ui/ReferralCodeEntry'

// A typical professional resume writer's fee, in cents (USD only - see showWriterCompare). Used as the
// reference point on the offer; change it here if the market figure you stand behind changes.
const WRITER_TYPICAL_CENTS = 15000

// Optional hardship price. The discount itself is an ordinary referral code created in the admin
// (an internal partner with a 0% commission, tier prices set to half of today's), so pricing,
// reservations and receipts all go through the existing path. When VITE_HARDSHIP_CODE is unset the
// whole feature is simply absent. The percentage shown is measured from live prices, never typed.
const HARDSHIP_CODE = (import.meta.env.VITE_HARDSHIP_CODE || '').trim().toUpperCase()

// PriceTag — byTier() always returns a usable value (falls back to the correct standard price
// internally if /api/pricing hasn't loaded or failed), so this only decides whether to show the
// crossed-out anchor. Currency is threaded through: this is the literal checkout button.
function PriceTag({ tier, byTier, currency }) {
  const live = byTier(tier)
  const onPromo = live.amount !== live.originalAmount
  return (
    <>
      {onPromo && <s className="opacity-60 mr-1">{fmtPrice(live.originalAmount, currency)}</s>}
      {fmtPrice(live.amount, currency)}
    </>
  )
}

// One option on the offer. `featured` raises the card and adds the "best for most people" flag;
// `children` is the checkout button(s), so each tier keeps its own label, loading and disabled state.
function OfferCard({ title, price, note, points, featured = false, nudge = '', children }) {
  return (
    <div
      className={`relative flex flex-col rounded-xl bg-white p-5 ${
        featured ? 'border-2 border-blue-700 shadow-md sm:-translate-y-1' : 'border border-gray-200'
      }`}
    >
      {featured && (
        <span className="absolute -top-3 left-4 rounded-full bg-blue-700 px-3 py-0.5 text-xs font-semibold text-white">
          Best for most people
        </span>
      )}
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <p className="mt-1 text-3xl font-bold tracking-tight text-gray-900">{price}</p>
      {note && <p className="text-xs text-gray-500">{note}</p>}
      <ul className="mt-3 mb-4 flex-1 space-y-1.5 text-sm text-gray-600">
        {points.map(([ok, text]) => (
          <li key={text} className="flex gap-2">
            <span aria-hidden="true" className={ok ? 'text-green-600 font-bold' : 'text-gray-400'}>{ok ? '✓' : '–'}</span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {nudge && <p className="mb-2 text-sm font-medium text-blue-700">{nudge}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  )
}

export default function FixBanner({
  scan, onPay, onRedeemCredit, freeFixCredits = 0,
  referralCode = '', onApplyReferralCode = () => {},
  // Buttons disable as soon as ANY pay-related action starts (payLoading); the specific tier being
  // paid for (payingTier) gets the spinner via Button's own `loading` prop.
  payLoading = false, payingTier = null,
  // Builds + scores the ATS-formatted file a purchase would deliver (POST /structure).
  onCheckFormatted = null, checkingFormatted = false, checkFormattedError = ''
}) {
  const { byTier, pricing, pricingFailed, refresh: refreshPricing, clockOffsetMs } = usePricing(referralCode, { scanId: scan?.id })
  // Quote of the hardship code, used only to measure the real discount. With no code configured this is
  // the plain no-code quote, which the hook shares with the call above (no extra request).
  const hard = usePricing(HARDSHIP_CODE, { scanId: scan?.id })
  if (!scan || !['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status)) return null
  if (scan.fixPurchased) return null

  const score = scan.atsScore ?? 0
  // Prefer the server-computed flag (same constant the BADGE tier enforces); the comparison is only
  // a fallback for a scan object that predates the field.
  const badgeEligible = scan.badgeEligible ?? (score >= ATS_BADGE_THRESHOLD)
  const hasCredit = freeFixCredits > 0
  const currency = pricing?.currency
  const gap = Math.max(0, ATS_BADGE_THRESHOLD - score)

  // For an UPLOADED FILE the score measures the upload itself, but a Badge delivers the regenerated,
  // ATS-formatted document - a different text that can land under the credential bar even when the
  // upload cleared it. So for a file the Badge is only offered once that formatted file has been
  // scored AND clears the bar. Typed / saved-profile scans are already scored on the rendered document.
  const isFile = scan.inputMode === 'file'
  const formatted = scan.atsDetail?.formattedScore ?? null
  const formattedKnown = !isFile || formatted != null
  const badgeSafe = !isFile || (formatted != null && formatted >= ATS_BADGE_THRESHOLD)
  const formattedLow = isFile && formatted != null && formatted < ATS_BADGE_THRESHOLD

  // The "$X more" nudge uses live prices, so it is true during a promo, a referral discount or neither.
  const stepUp = byTier('FIX').amount - byTier('FIX_PLAIN').amount
  const nudge = stepUp > 0 ? `Only ${fmtPrice(stepUp, currency)} more than the plain fix` : ''

  const normalizedCode = (referralCode || '').trim().toUpperCase()
  const hardshipApplied = !!HARDSHIP_CODE && normalizedCode === HARDSHIP_CODE
  // Offered only when nobody else's code is already in play (their attribution is not ours to replace)
  // and the live quote shows the code really does lower today's price.
  const hardshipPct = (() => {
    if (!HARDSHIP_CODE || normalizedCode || !hard.pricing) return 0
    const base = byTier('FIX').amount
    const h = hard.byTier('FIX')
    if (!h.referralApplied || !h.discountApplied || !(base > 0)) return 0
    return Math.round((1 - h.amount / base) * 100)
  })()
  const hardshipLine = hardshipApplied ? (
    <p className="mt-3 text-sm text-gray-600" data-testid="hardship-applied">
      Hardship price applied.{' '}
      <button type="button" className="underline underline-offset-2 hover:text-gray-900" disabled={payLoading}
        onClick={() => onApplyReferralCode('')}>Remove</button>
    </p>
  ) : hardshipPct > 0 ? (
    <p className="mt-3 text-sm text-gray-600" data-testid="hardship-offer">
      Between jobs or in school?{' '}
      <button type="button" className="font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-800" disabled={payLoading}
        onClick={() => onApplyReferralCode(HARDSHIP_CODE)}>
        Take {hardshipPct}% off any fix
      </button>
      . No proof needed.
    </p>
  ) : null

  // The reference point only makes sense in dollars.
  const showWriterCompare = (currency || 'USD') === 'USD'
  const compare = showWriterCompare && (
    <div className="grid gap-3 py-3 sm:grid-cols-3" data-testid="writer-compare">
      <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600">
        <span className="text-xs text-gray-500">Hire a resume writer</span>
        <b className="block text-2xl text-gray-900">{fmtPrice(WRITER_TYPICAL_CENTS, currency)}+</b>
        Usually days of back-and-forth.
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm text-gray-600">
        <span className="text-xs text-gray-500">Change nothing</span>
        <b className="block text-2xl text-gray-900">{fmtPrice(0, currency)}</b>
        Same filter, same silence on your next applications.
      </div>
      <div className="rounded-lg border-2 border-blue-700 bg-white p-3 text-sm text-gray-600">
        <span className="text-xs text-gray-500">Full fix + Verified</span>
        <b className="block text-2xl text-gray-900"><PriceTag tier="FIX" byTier={byTier} currency={currency} /></b>
        Rewritten and delivered on this page.
      </div>
    </div>
  )

  const showCountdown = pricing?.promoActive && pricing.promoEndsAt
  const shared = (
    <>
      {showCountdown && (
        <PromoCountdown endsAt={pricing.promoEndsAt} clockOffsetMs={clockOffsetMs} onExpire={refreshPricing} className="mb-3" />
      )}
      {hasCredit && (
        <p className="text-sm text-green-700 mt-1 mb-3 font-medium">
          You have {freeFixCredits} free fix credit{freeFixCredits > 1 ? 's' : ''} — use one below at no charge.
        </p>
      )}
      {pricingFailed && <PricingFailedNotice referralCode={referralCode} onRetry={refreshPricing} />}
      <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} disabled={payLoading} />
    </>
  )

  const guarantee = (
    <p className="mt-4 border-t border-gray-200 pt-3 text-sm text-gray-600" data-testid="fix-guarantee">
      <span className="font-semibold text-gray-800">If the fixed version still falls short, you don't pay again.</span>{' '}
      Every fix includes {MAX_FIX_RETRIES} free retries. If it still misses, you get a free fix credit. This is a credit, not a refund.
    </p>
  )

  // <80: the plain rewrite, or the full fix with the Verified credential. The credential-only option
  // is not offered here — it needs a score of at least ATS_BADGE_THRESHOLD.
  if (!badgeEligible) {
    return (
      <section className="rounded-xl border border-blue-200 bg-blue-50 p-5 sm:p-6">
        <p className="text-lg font-semibold text-blue-900">
          {score < 75
            ? 'Your resume is being rejected by ATS filters'
            : 'Boost your score and unlock Verified status'}
        </p>
        <p className="mt-1 mb-3 text-sm text-blue-800">
          {gap > 0 && <>You are {gap} point{gap === 1 ? '' : 's'} short of the {ATS_BADGE_THRESHOLD} a resume needs to earn the Verified credential. </>}
          A fix rewrites your own experience in the words the job post and the software look for.
        </p>
        {compare}
        {shared}
        <div className="grid gap-4 pt-2 sm:grid-cols-2">
          <OfferCard
            title="Fix only"
            price={<PriceTag tier="FIX_PLAIN" byTier={byTier} currency={currency} />}
            points={[[true, 'AI rewrite using your real experience'], [true, 'ATS-optimised .docx and PDF'], [false, 'No Verified credential']]}
          >
            <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary" disabled={payLoading} loading={payingTier === 'FIX_PLAIN'}>
              Fix My Resume — <PriceTag tier="FIX_PLAIN" byTier={byTier} currency={currency} />
            </Button>
          </OfferCard>
          <OfferCard
            featured
            title="Full fix + Verified"
            price={<PriceTag tier="FIX" byTier={byTier} currency={currency} />}
            points={[[true, 'Everything in Fix only'], [true, 'Passthrough Verified credential employers can check'], [true, 'Shareable link and badge']]}
            nudge={nudge}
          >
            {hasCredit && (
              <Button onClick={onRedeemCredit} variant="secondary" disabled={payLoading} loading={payLoading && !payingTier}>
                Use Free Credit
              </Button>
            )}
            <Button onClick={() => onPay('FIX')} disabled={payLoading} loading={payingTier === 'FIX'}>
              Fix + Verified Credential — <PriceTag tier="FIX" byTier={byTier} currency={currency} />
            </Button>
          </OfferCard>
        </div>
        {guarantee}
        {hardshipLine}
      </section>
    )
  }

  // 80+: the credential is the natural next step; a rewrite is optional, not the headline.
  return (
    <section className="rounded-xl border border-green-200 bg-green-50 p-5 sm:p-6">
      <p className="mb-1 text-lg font-semibold text-green-900">
        ✓ Your resume passed ATS — you're Verified-eligible
      </p>
      <p className="mb-3 text-sm text-green-800">
        You may not need a rewrite. The credential lets an employer check your score and confirm the file hasn't been changed.
        A rewrite is optional.
      </p>
      {isFile && !formattedKnown && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2" data-testid="formatted-check">
          <p className="text-sm text-amber-900">
            The credential is issued on the ATS-formatted version we build from your file, which can score
            differently from the file you uploaded. Check it first — it takes a few seconds.
          </p>
          {onCheckFormatted && (
            <Button onClick={onCheckFormatted} variant="secondary" className="mt-2" loading={checkingFormatted} disabled={checkingFormatted || payLoading}>
              Check the formatted file
            </Button>
          )}
          {checkFormattedError && <p role="alert" className="mt-2 text-sm text-red-700">{checkFormattedError}</p>}
        </div>
      )}
      {formattedLow && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="formatted-low">
          The ATS-formatted file we'd deliver scores {formatted} — under the {ATS_BADGE_THRESHOLD} the credential needs — so a
          Credential-only purchase would not come out verified. A Fix rewrites it to clear the bar.
        </p>
      )}
      {isFile && formatted != null && !formattedLow && (
        <p className="mb-3 text-sm text-green-800" data-testid="formatted-ok">
          The ATS-formatted file we'd deliver scores {formatted} — credential-ready.
        </p>
      )}
      {shared}
      <div className={`grid gap-4 pt-2 ${badgeSafe ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        {badgeSafe && (
          <OfferCard
            featured
            title="Verified credential"
            price={<PriceTag tier="BADGE" byTier={byTier} currency={currency} />}
            points={[[true, 'Verified link and badge'], [true, 'Employers see your score and an unchanged-file check'], [false, 'No rewrite']]}
          >
            <Button onClick={() => onPay('BADGE')} disabled={payLoading} loading={payingTier === 'BADGE'}>
              Verified Credential only — <PriceTag tier="BADGE" byTier={byTier} currency={currency} />
            </Button>
          </OfferCard>
        )}
        <OfferCard
          title="Fix only"
          price={<PriceTag tier="FIX_PLAIN" byTier={byTier} currency={currency} />}
          points={[[true, 'AI rewrite using your real experience'], [true, 'ATS-optimised .docx and PDF'], [false, 'No Verified credential']]}
        >
          <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary" disabled={payLoading} loading={payingTier === 'FIX_PLAIN'}>
            Fix My Resume, No Credential — <PriceTag tier="FIX_PLAIN" byTier={byTier} currency={currency} />
          </Button>
        </OfferCard>
        <OfferCard
          featured={!badgeSafe}
          title="Full fix + Verified"
          price={<PriceTag tier="FIX" byTier={byTier} currency={currency} />}
          points={[[true, 'Everything in Fix only'], [true, 'Passthrough Verified credential']]}
          nudge={nudge}
        >
          {hasCredit && (
            <Button onClick={onRedeemCredit} variant="secondary" disabled={payLoading} loading={payLoading && !payingTier}>
              Full AI Fix — Free Credit
            </Button>
          )}
          <Button onClick={() => onPay('FIX')} variant={badgeSafe ? 'secondary' : 'primary'} disabled={payLoading} loading={payingTier === 'FIX'}>
            Full AI Fix + Credential — <PriceTag tier="FIX" byTier={byTier} currency={currency} />
          </Button>
        </OfferCard>
      </div>
      {guarantee}
      {hardshipLine}
    </section>
  )
}
