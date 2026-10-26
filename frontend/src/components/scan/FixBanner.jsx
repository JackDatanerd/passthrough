import Button from '../ui/Button'
import Badge from '../ui/Badge'
import Alert from '../ui/Alert'
import PromoCountdown from '../ui/PromoCountdown'
import { usePricing, fmtPrice } from '../../hooks/usePricing'
import { recommendPlan } from '../../lib/scanTiers'
import { ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES } from '../../lib/scoreThresholds'
import { ReferralCodeEntry, PricingFailedNotice } from '../ui/ReferralCodeEntry'
import NewTag from '../ui/NewTag'
import { formatMonthDay } from '../../lib/utils'
import { coverLetterText } from '../../lib/coverLetterOffer'
import HumanRewriteOption from './HumanRewriteOption'

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
function PriceTag({ tier, byTier, currency, struckAfter = false }) {
  const live = byTier(tier)
  const onPromo = live.amount !== live.originalAmount
  const struck = onPromo && <s className={struckAfter ? 'ml-1.5 text-base font-semibold text-gray-500' : 'opacity-60 mr-1'}>{fmtPrice(live.originalAmount, currency)}</s>
  return (
    <>
      {!struckAfter && struck}
      {fmtPrice(live.amount, currency)}
      {struckAfter && struck}
    </>
  )
}

export default function FixBanner({
  provisional = false,
  scan, onPay, onRedeemCredit, freeFixCredits = 0,
  referralCode = '', onApplyReferralCode = () => {},
  // The account's personal welcome code (hooks/useWelcomeOffer), passed only while no other code is in play. It prices the page like any
  // code, but it is never shown as a code to type or remove: the buyer sees one line saying their welcome price is applied.
  welcomeOffer = null,
  // Buttons disable as soon as ANY pay-related action starts (payLoading); the specific tier being
  // paid for (payingTier) gets the spinner via Button's own `loading` prop.
  payLoading = false, payingTier = null,
  // Builds + scores the ATS-formatted file a purchase would deliver (POST /structure).
  onCheckFormatted = null, checkingFormatted = false, checkFormattedError = '',
  // Anything the page needs to say inside the offer itself (a visitor is told an account comes first), rendered at its foot.
  children = null,
}) {
  const { byTier, pricing, pricingFailed, refresh: refreshPricing, clockOffsetMs } = usePricing(referralCode || welcomeOffer?.code || '', { scanId: scan?.id })
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

  const showCountdown = pricing?.promoActive && pricing.promoEndsAt
  // Said only once the quote confirms the discount is real for THIS buyer (the code can be spent, expired or refused by the time the
  // price loads), and only about the full fix, the one tier a welcome code prices.
  const fixQuote = byTier('FIX')
  const welcomeApplied = !!welcomeOffer && !referralCode && !!fixQuote?.referralApplied && !!fixQuote?.discountApplied
  const welcomeLine = welcomeApplied ? (
    <p role="status" className="mt-3 text-sm font-medium text-emerald-700" data-testid="welcome-applied">
      Welcome price applied: {welcomeOffer.percentOff}% off the Full fix + Verified, {fmtPrice(fixQuote.amount, currency)} instead of {fmtPrice(welcomeOffer.listAmountCents, currency)}.{' '}
      <span className="font-normal text-emerald-700/80">
        Yours alone, and it works once, until {formatMonthDay(welcomeOffer.expiresAt) ?? ''}.
      </span>
    </p>
  ) : null

  // Short form of the guarantee, as the last bullet of what the purchase includes.
  const retriesLine = `${MAX_FIX_RETRIES} free retries. Still short? You get a free fix credit.`
  const includesFix = [
    [false, 'AI rewrite using only your real experience'],
    [false, 'ATS-ready .docx and PDF'],
    [false, 'Passthrough Verified link & badge'],
    [true, coverLetterText(pricing, 'FIX')],
    [false, retriesLine],
  ]
  // The credential-only plan rewrites nothing: it formats what is already there, scores the real file, and issues the link.
  const includesBadge = [
    [false, 'Passthrough Verified link & badge'],
    [false, 'An integrity check employers can run'],
    [false, 'ATS-ready .docx and PDF of your existing resume'],
    [true, coverLetterText(pricing, 'BADGE')],
    [false, `Nothing is rewritten. Your ${score} stays your ${score}.`],
  ]

  const guaranteeFix = (
    <p className="mt-2 text-xs text-gray-600" data-testid="fix-guarantee">
      <span className="font-semibold text-gray-800">If the fixed version still falls short, you don't pay again.</span>{' '}
      Every fix includes {MAX_FIX_RETRIES} free retries. If it still misses, you get a free fix credit. This is a credit, not a refund.
    </p>
  )
  const guaranteeBadge = (
    <p className="mt-2 text-xs text-gray-600" data-testid="fix-guarantee">
      <span className="font-semibold text-gray-800">The credential is only issued if the file we deliver scores {ATS_BADGE_THRESHOLD} or more.</span>{' '}
      If it doesn't, your files carry the plain Scan Report wording and you get a free fix credit. This is a credit, not a refund.
    </p>
  )

  // A second way to buy, as a quiet line under the main button: "Just the rewrite, no Verified?  Fix only $29".
  const Alt = ({ lead, tier, label, testid }) => (
    <div className="mt-3 text-sm text-gray-600" data-testid={testid}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{lead}</span>
      <button type="button" onClick={() => onPay(tier)} disabled={payLoading}
        className="font-bold text-blue-700 underline underline-offset-2 hover:text-blue-800 disabled:opacity-60">
        {label} {'\u00b7'} <PriceTag tier={tier} byTier={byTier} currency={currency} struckAfter />
      </button>
    </div>
    <p className="mt-0.5 text-xs text-gray-500" data-testid={`${testid}-letters`}>{coverLetterText(pricing, tier)}</p>
    </div>
  )

  const eligible = badgeEligible
  // The plan this scan should lead with (lib/scanTiers.js, one rule for every surface that recommends one).
  const plan = recommendPlan({ eligible, badgeSafe, provisional })
  const primary = plan.primary
  const isBadge = primary === 'BADGE'
  const includes = isBadge ? includesBadge : includesFix
  const guarantee = isBadge ? guaranteeBadge : guaranteeFix
  return (
    <section data-testid="offer-card" data-primary={primary} className="rounded-xl border border-blue-300 bg-blue-50 p-5 shadow-sm">
      {showCountdown ? (
        <PromoCountdown endsAt={pricing.promoEndsAt} clockOffsetMs={clockOffsetMs} label={pricing.promoLabel} onExpire={refreshPricing} className="mb-2" />
      ) : (
        <Badge variant="amber" className="mb-2">{isBadge ? 'Best for your score' : 'Best for most people'}</Badge>
      )}
      <h3 className="text-lg font-semibold text-gray-900">{isBadge ? 'Get your Verified credential' : 'Fix & verify my resume'}</h3>
      <div className="mt-2 text-3xl font-bold leading-none text-gray-900" data-testid="offer-price">
        <PriceTag tier={primary} byTier={byTier} currency={currency} struckAfter />
      </div>

      {eligible && (
        <p className="mt-3 text-sm text-gray-700">
          <b className="text-green-800">Your resume passed ATS and is Verified-eligible.</b>{' '}
          {isBadge
            ? 'No rewrite is needed to earn the credential. It lets an employer check your score and confirm the file has not been changed.'
            : 'You may not need a rewrite. The credential lets an employer check your score and confirm the file has not been changed. A rewrite is optional.'}
        </p>
      )}
      {!eligible && !provisional && gap > 0 && (
        <p className="mt-3 text-sm text-gray-700">You are {gap} point{gap === 1 ? '' : 's'} short of the {ATS_BADGE_THRESHOLD} a resume needs to earn the Verified credential. A fix rewrites your own experience in the words the job post and the software look for.</p>
      )}

      {eligible && isFile && !formattedKnown && (
        <Alert variant="warning" className="mt-3" data-testid="formatted-check">
          <p>
            The credential is issued on the ATS-formatted version we build from your file, which can score
            differently from the file you uploaded. Check it first. It takes a few seconds.
          </p>
          {onCheckFormatted && (
            <Button onClick={onCheckFormatted} variant="secondary" className="mt-2" loading={checkingFormatted} disabled={checkingFormatted || payLoading}>
              Check the formatted file
            </Button>
          )}
          {checkFormattedError && <p role="alert" className="mt-2 text-sm text-red-700">{checkFormattedError}</p>}
        </Alert>
      )}
      {eligible && formattedLow && (
        <Alert variant="warning" className="mt-3" data-testid="formatted-low">
          The ATS-formatted file we'd deliver scores {formatted}, under the {ATS_BADGE_THRESHOLD} the credential needs, so a
          Credential-only purchase would not come out verified. A Fix rewrites it to clear the bar.
        </Alert>
      )}
      {eligible && isFile && formatted != null && !formattedLow && (
        <Alert variant="success" className="mt-3" data-testid="formatted-ok">
          The ATS-formatted file we'd deliver scores {formatted}, credential-ready.
        </Alert>
      )}

      <ul className="my-3 grid gap-1.5 text-sm text-gray-700">
        {includes.map(([isNew, text]) => (
          <li key={text} className="flex gap-1.5"><span aria-hidden="true" className="font-bold text-green-700">{'\u2713'}</span><span>{isNew && <><NewTag />{' '}</>}{text}</span></li>
        ))}
      </ul>

      {pricingFailed && <PricingFailedNotice referralCode={referralCode} onRetry={refreshPricing} />}
      {hasCredit && (
        <>
          <p className="mb-2 text-sm font-medium text-green-700">You have {freeFixCredits} free fix credit{freeFixCredits > 1 ? 's' : ''}. Use one at no charge.</p>
          <Button onClick={onRedeemCredit} variant="secondary" className="mb-2 w-full" disabled={payLoading} loading={payLoading && !payingTier}>
            Use my free fix credit
          </Button>
        </>
      )}
      <Button onClick={() => onPay(primary)} size="lg" className="w-full" disabled={payLoading} loading={payingTier === primary}>
        {isBadge ? 'Get my Verified credential' : 'Fix & verify my resume'} <span aria-hidden="true">{'\u2192'}</span>
      </Button>
      <p className="mt-2 text-center text-xs text-gray-500">{isBadge ? "You've seen the full breakdown free. Pay only for the credential." : "You've seen the full breakdown free. Pay only for the fix."}</p>

      {isBadge && <Alt lead="Want it rewritten too?" tier="FIX" label="Fix & verify" testid="alt-fix" />}
      <Alt lead="Just the rewrite, no Verified?" tier="FIX_PLAIN" label="Fix only" testid="alt-plain" />

      <HumanRewriteOption />   {/* Experts Phase 0A demand test: renders nothing unless the server flag is on */}

      {showWriterCompare && (
        <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-1 border-t border-gray-200 pt-2.5 text-xs text-gray-500" data-testid="writer-compare" aria-label="How it compares">
          <span><b className="text-gray-900">{fmtPrice(WRITER_TYPICAL_CENTS, currency)}+</b> resume writer, days</span>
          <span><b className="text-gray-900">{fmtPrice(0, currency)}</b> change nothing</span>
        </div>
      )}

      <p className="mt-3 rounded-lg border border-dashed border-blue-300 bg-white px-3 py-2 text-xs text-gray-600">
        After you pay, <b>Your resume</b> and <b>Apply</b> tabs open here. Nothing to find.
      </p>
      {guarantee}
      {welcomeLine}
      <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} disabled={payLoading} collapsible />
      {hardshipLine}
      {children}
    </section>
  )
}
