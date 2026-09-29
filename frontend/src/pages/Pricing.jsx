import { useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import PromoCountdown from '../components/ui/PromoCountdown'
import { usePricing, fmtPrice } from '../hooks/usePricing'
import { getStoredReferralCode, setStoredReferralCode } from '../hooks/useReferralCapture'
import { ReferralCodeEntry, PricingFailedNotice } from '../components/ui/ReferralCodeEntry'
import { ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES } from '../lib/scoreThresholds'

// AUDIT FIX (bug): currency now threaded through from the page's own
// /api/pricing response (see usePricing.js's fmtPrice comment) — this page
// used to always render a `$`, even if PAYSTACK_CURRENCY were ever non-USD.
function PriceBlock({ tier, currency }) {
  const onPromo = tier.amount !== tier.originalAmount
  return (
    <div className="mb-1 flex items-baseline gap-2">
      {onPromo && (
        <span className="text-xl text-gray-400 line-through">{fmtPrice(tier.originalAmount, currency)}</span>
      )}
      <span className="text-4xl font-bold text-gray-900">{fmtPrice(tier.amount, currency)}</span>
    </div>
  )
}

// The three paid tiers this page prices, in the order they're rendered below.
const PAID_TIERS = ['BADGE', 'FIX_PLAIN', 'FIX']

export default function Pricing() {
  // AUDIT FIX (feature gap): this page used to call usePricing() with no
  // code at all, so a visitor referred via ?ref=CODE — captured globally by
  // useReferralCapture in App.jsx the same as on any other page — never saw
  // their discount here, only at actual checkout (ScanResult.jsx/FixBanner).
  // Same initialize-from-storage pattern ScanResult.jsx already uses for
  // the identical reason.
  // AUDIT FIX (Payments & Pricing pass 1 — G5): was read-only (useState with
  // no setter) — a visitor with a code that didn't arrive via a clicked
  // ?ref= link had no way to enter one on this page at all, unlike checkout
  // (FixBanner). Same read-storage/re-read-after-apply pattern
  // ScanResult.jsx already uses for FixBanner's identical field.
  const [referralCode, setReferralCode] = useState(getStoredReferralCode())
  const { pricing, byTier, pricingFailed, refresh: refreshPricing, clockOffsetMs } = usePricing(referralCode)

  function handleApplyReferralCode(code) {
    setStoredReferralCode(code)
    setReferralCode(getStoredReferralCode())   // re-read: normalizes casing/trim, empty string if cleared
  }

  // FEATURE GAP CLOSED (Payments & Pricing pass 1 — G5): "80+" and "two free
  // manual retries" below used to be hardcoded copy that could silently
  // drift from ATS_BADGE_THRESHOLD/MAX_FIX_RETRIES (the numbers that
  // actually gate eligibility and retry count). /api/pricing now returns
  // both live from the backend's own constants.js; the frontend constants
  // are only the fallback for the brief gap before that first response
  // lands (or if it never does).
  const badgeThreshold = pricing?.badgeThreshold ?? ATS_BADGE_THRESHOLD
  const maxFixRetries  = pricing?.maxFixRetries ?? MAX_FIX_RETRIES

  // AUDIT FIX (Section 3/4 re-audit, bug): pricing.referralApplied (from
  // pricing.controller.js) is true if the code discounts ANY ONE of the
  // three tiers — a partner's tier_prices can legitimately cover only some
  // of them (see referral.service.js). The banner used to read that single
  // flag and claim "prices below reflect your discount" unconditionally,
  // which overstated things whenever the code only discounted one or two of
  // the three plans shown here. Count which tiers are actually discounted
  // and word the banner to match.
  const discountedTierCount = PAID_TIERS.filter(t => byTier(t).referralApplied).length

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      {/* AUDIT FIX (Payments & Pricing pass 1, bug — B6): max-w-3xl (768px) held
          a 4-column grid on desktop — after gaps and padding, each of the
          four cards had roughly 120px of usable text width. max-w-6xl gives
          each card the same ~280-300px a 2-column tablet layout already had,
          without changing the sm:grid-cols-2 / lg:grid-cols-4 breakpoints or
          any card's own markup. */}
      <main className="flex-1 max-w-6xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Pricing</h1>
          <p className="text-gray-500 mb-4">Scan free, always. Pay once if you want the fix. No subscriptions.</p>
          {referralCode && pricing?.referralApplied && (
            <p className="text-sm font-medium text-emerald-700 mb-4">
              ✓ Referral code <span className="font-mono">{referralCode}</span> applied — {
                discountedTierCount >= PAID_TIERS.length
                  ? 'prices below reflect your discount.'
                  : 'reflected in the discounted plan(s) below.'
              }
            </p>
          )}
          {/* AUDIT FIX (feature gap): usePricing()'s pricingFailed signal was
              exported but never consumed anywhere in the app. byTier()'s
              fallback to the correct standard price means a failed fetch
              looks identical to a normal load — fine on its own, but if a
              referral code was supposed to apply and the fetch that would
              confirm it never came back, a visitor would just see full
              standard pricing with nothing telling them their code wasn't
              actually checked. Mirrors the same notice now shown at
              checkout (FixBanner.jsx). */}
          {pricingFailed && (
            <div className="inline-block text-left">
              <PricingFailedNotice referralCode={referralCode} onRetry={refreshPricing} className="text-sm mb-4" />
            </div>
          )}
          {pricing?.promoActive && pricing.promoEndsAt && (
            <PromoCountdown endsAt={pricing.promoEndsAt} clockOffsetMs={clockOffsetMs} onExpire={refreshPricing} className="mb-8" />
          )}
          {/* FEATURE GAP CLOSED (Payments & Pricing pass 1 — G5): FixBanner
              (checkout) has always let a visitor type a code by hand; this
              page — often a visitor's FIRST stop, before they've even
              scanned — never did. */}
          <div className="flex justify-center">
            <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={handleApplyReferralCode} disabled={false} />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Free */}
          <div className="rounded-xl border border-gray-200 p-6 flex flex-col">
            <div className="text-sm text-gray-500 mb-1">Free forever</div>
            <div className="text-4xl font-bold text-gray-900 mb-1">$0</div>
            <p className="text-sm text-gray-500 mb-6">1 scan/hour with no account, or 3/day with a free account</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['ATS score out of 100','Keyword gap analysis','Format & section check','Content quality score','No account required to start'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors">
              Start scanning
            </Link>
          </div>

          {/* Badge */}
          <div className="rounded-xl border border-gray-200 p-6 flex flex-col">
            <div className="text-sm text-gray-500 mb-1">Credential only</div>
            <PriceBlock tier={byTier('BADGE')} currency={pricing?.currency} />
            <p className="text-sm text-gray-500 mb-6">Score {badgeThreshold}+ required · no content changes</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['Passthrough Verified credential','Employer-checkable verification','Cryptographic integrity check','ATS-optimised .docx','Beautiful PDF'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan first →
            </Link>
          </div>

          {/* Fix, no credential */}
          <div className="rounded-xl border border-gray-200 p-6 flex flex-col">
            <div className="text-sm text-gray-500 mb-1">Fix only</div>
            <PriceBlock tier={byTier('FIX_PLAIN')} currency={pricing?.currency} />
            <p className="text-sm text-gray-500 mb-6">Any score · no verification link</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['Full AI rewrite','ATS-optimised .docx','Beautiful designer PDF','Retry until it passes','No Passthrough Verified link — just your documents'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan first →
            </Link>
          </div>

          {/* Fix */}
          <div className="rounded-xl border-2 border-blue-600 p-6 flex flex-col relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs px-3 py-1 rounded-full">
              Most popular
            </div>
            <div className="text-sm text-blue-600 font-medium mb-1">Full fix</div>
            <PriceBlock tier={byTier('FIX')} currency={pricing?.currency} />
            <p className="text-sm text-gray-500 mb-6">Any score</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['Full AI rewrite','ATS-optimised .docx','Beautiful designer PDF','Passthrough Verified credential','Cryptographic integrity check','Employer-checkable verification'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan first →
            </Link>
          </div>
        </div>

        {/* Retry guarantee callout */}
        <div className="mt-10 bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <p className="font-semibold text-blue-900 mb-1">
            Included with every fix: we don't stop until you pass.
          </p>
          <p className="text-sm text-blue-700 leading-relaxed max-w-xl mx-auto">
            Multiple AI rewrite attempts, {maxFixRetries} free manual retries, and if we still can't
            get you past the verification threshold, a free credit for your next resume.
          </p>
        </div>

        <p className="text-center text-sm text-gray-400 mt-8">
          Payments processed by Paystack. One-time charge — no subscriptions, no surprise fees.
        </p>

        {/* Employer link */}
        <div className="mt-12 pt-8 border-t border-gray-100 text-center">
          <p className="text-sm text-gray-500 mb-1">Hiring, not job hunting?</p>
          <Link to="/#employers" className="text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2">
            See how employers verify candidates →
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  )
}
