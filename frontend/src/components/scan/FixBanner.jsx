import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../ui/Button'
import { usePricing, fmtPrice } from '../../hooks/usePricing'
import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// PriceTag — byTier() always returns a usable value (falls back to the
// correct standard price internally if /api/pricing hasn't loaded or
// failed), so this only needs to decide whether to show the anchor.
// AUDIT FIX (bug): currency now threaded through — this is the literal
// checkout button; a `$` here when PAYSTACK_CURRENCY isn't USD would have
// been the most consequential instance of the fmtPrice bug (see
// usePricing.js's fmtPrice comment).
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

// Two states: a code is already applied (show the confirmation + a way to
// change it), or no code is applied yet (show the entry field). This is the
// ONLY place a person can type a code by hand — a ?ref= link in the URL
// pre-fills it via useReferralCapture, but plenty of real referral traffic
// is a code heard on a podcast or read off a screenshot, not a clicked link.
function ReferralCodeEntry({ referralCode, pricing, onApply, disabled }) {
  const [value, setValue] = useState(referralCode || '')
  const [editing, setEditing] = useState(!referralCode)

  function handleApply() {
    onApply(value)
    setEditing(false)
  }

  if (referralCode && pricing?.referralApplied && !editing) {
    return (
      <p className="text-sm font-medium text-emerald-700 mb-3">
        ✓ Referral code <span className="font-mono">{referralCode}</span> applied —{' '}
        <button type="button" onClick={() => setEditing(true)} disabled={disabled}
          className="underline font-normal text-emerald-700/80 hover:text-emerald-900 disabled:opacity-40 disabled:no-underline">
          change
        </button>
      </p>
    )
  }

  // AUDIT FIX (feature gap): a code that's set (typed and applied, or
  // arrived pre-filled via a ?ref= link — see useReferralCapture) but that
  // pricing reports back as NOT applied means the code doesn't exist, is
  // inactive, or has expired. This previously fell straight through to the
  // plain entry field with zero indication anything had been tried — no way
  // to tell "haven't applied a code yet" from "applied one that didn't
  // work". `pricing` is null while /api/pricing is still loading for this
  // code (see usePricing) — checking it explicitly avoids flashing an error
  // during that normal loading gap.
  const invalid = referralCode && !editing && pricing && !pricing.referralApplied

  return (
    <div className="mb-3">
      {invalid && (
        <p className="text-sm text-red-600 mb-1">
          That code doesn't look right — check it and try again, or leave it blank.
        </p>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleApply()}
          placeholder="Have a referral code?"
          disabled={disabled}
          className={`text-sm border rounded-md px-3 py-1.5 w-52 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 ${invalid ? 'border-red-300' : 'border-gray-300'}`}
        />
        <button type="button" onClick={handleApply}
          disabled={!value.trim() || disabled}
          className="text-sm font-medium text-blue-700 hover:underline disabled:opacity-40 disabled:no-underline">
          Apply
        </button>
      </div>
    </div>
  )
}

export default function FixBanner({
  scan, onPay, onRedeemCredit, freeFixCredits = 0,
  referralCode = '', onApplyReferralCode = () => {},
  // BUGFIX: previously accepted no loading state at all — ScanResult.jsx
  // tracked payLoading throughout handlePay but never passed it down, so
  // nothing here disabled while a payment was already in flight. Buttons
  // are disabled as soon as ANY pay-related action starts (payLoading),
  // and the specific tier being paid for (payingTier) gets the visual
  // spinner via Button's own `loading` prop.
  payLoading = false, payingTier = null
}) {
  const navigate = useNavigate()
  const { byTier, pricing } = usePricing(referralCode)
  if (!scan || !['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status)) return null
  if (scan.fixPurchased) return null

  const score        = scan.atsScore ?? 0
  // AUDIT FIX: this used to be its own `score >= 80` — a second, independent
  // hardcoded copy of ATS_BADGE_THRESHOLD, even though `scan.badgeEligible`
  // (computed server-side from the live constant — see scan.controller.js's
  // getScan) is sitting right there on the same `scan` prop. Preferring it
  // means this can never disagree with what initiateFix actually enforces
  // server-side for the BADGE tier; the threshold comparison is kept only
  // as a fallback for a scan object that predates this field.
  const badgeEligible = scan.badgeEligible ?? (score >= ATS_BADGE_THRESHOLD)
  const hasCredit      = freeFixCredits > 0

  // <75 or 75-79: full fix ($49), or just the rewrite with no credential ($39)
  // (standard prices — see /api/pricing for live/promo amounts)
  //
  // Text and buttons are stacked (not sharing a flex row) deliberately —
  // this used to be a single flex-row with text on the left and buttons
  // shrink-0'd on the right, which worked when button labels were short
  // (single price each). Once promo pricing added a second, crossed-out
  // price to every button label, the buttons alone got wide enough to
  // squeeze the text flex-item toward zero width, wrapping it one word per
  // line. Stacking avoids that whole class of "which side loses the width
  // fight" problem regardless of how long the button labels get, and
  // matches the layout the score-80+ branch below already uses.
  if (!badgeEligible) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-5">
        <p className="font-semibold text-blue-900">
          {score < 75
            ? 'Your resume is being rejected by ATS filters'
            : 'Boost your score and unlock Verified status'}
        </p>
        <p className="text-sm text-blue-700 mt-1 mb-1">
          Full AI rewrite + ATS-optimised .docx + beautiful PDF — with or without the Passthrough Verified credential
        </p>
        {hasCredit && (
          <p className="text-sm text-green-700 mt-1 mb-3 font-medium">
            You have {freeFixCredits} free fix credit{freeFixCredits > 1 ? 's' : ''} — use one below at no charge.
          </p>
        )}
        <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} disabled={payLoading} />
        <div className="flex flex-wrap gap-2 mt-3">
          {hasCredit && (
            <Button onClick={onRedeemCredit} variant="secondary" disabled={payLoading} loading={payLoading && !payingTier}>
              Use Free Credit
            </Button>
          )}
          <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary" disabled={payLoading} loading={payingTier === 'FIX_PLAIN'}>
            Fix My Resume — <PriceTag tier="FIX_PLAIN" byTier={byTier} currency={pricing?.currency} />
          </Button>
          <Button onClick={() => onPay('FIX')} disabled={payLoading} loading={payingTier === 'FIX'}>
            Fix + Verified Credential — <PriceTag tier="FIX" byTier={byTier} currency={pricing?.currency} />
          </Button>
        </div>
      </div>
    )
  }

  // 80+: badge only ($39), plain rewrite with no credential ($39), or full fix ($49)
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-5">
      <p className="font-semibold text-green-900 mb-1">
        ✓ Your resume passed ATS — you're Verified-eligible
      </p>
      <p className="text-sm text-green-800 mb-1">
        Get the Passthrough Verified credential employers can check, a plain rewrite with no credential, or both.
      </p>
      {hasCredit && (
        <p className="text-sm text-green-700 mb-3 font-medium">
          You have {freeFixCredits} free fix credit{freeFixCredits > 1 ? 's' : ''} — use one below at no charge.
        </p>
      )}
      <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} disabled={payLoading} />
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={() => onPay('BADGE')} variant="secondary" disabled={payLoading} loading={payingTier === 'BADGE'}>
          Verified Credential only — <PriceTag tier="BADGE" byTier={byTier} currency={pricing?.currency} />
        </Button>
        <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary" disabled={payLoading} loading={payingTier === 'FIX_PLAIN'}>
          Fix My Resume, No Credential — <PriceTag tier="FIX_PLAIN" byTier={byTier} currency={pricing?.currency} />
        </Button>
        {hasCredit && (
          <Button onClick={onRedeemCredit} variant="secondary" disabled={payLoading} loading={payLoading && !payingTier}>
            Full AI Fix — Free Credit
          </Button>
        )}
        <Button onClick={() => onPay('FIX')} disabled={payLoading} loading={payingTier === 'FIX'}>
          Full AI Fix + Credential — <PriceTag tier="FIX" byTier={byTier} currency={pricing?.currency} />
        </Button>
      </div>
    </div>
  )
}
