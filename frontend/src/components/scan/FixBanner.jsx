import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Button from '../ui/Button'
import { usePricing, fmtPrice } from '../../hooks/usePricing'

// PriceTag — byTier() always returns a usable value (falls back to the
// correct standard price internally if /api/pricing hasn't loaded or
// failed), so this only needs to decide whether to show the anchor.
function PriceTag({ tier, byTier }) {
  const live = byTier(tier)
  const onPromo = live.amount !== live.originalAmount
  return (
    <>
      {onPromo && <s className="opacity-60 mr-1">{fmtPrice(live.originalAmount)}</s>}
      {fmtPrice(live.amount)}
    </>
  )
}

// Two states: a code is already applied (show the confirmation + a way to
// change it), or no code is applied yet (show the entry field). This is the
// ONLY place a person can type a code by hand — a ?ref= link in the URL
// pre-fills it via useReferralCapture, but plenty of real referral traffic
// is a code heard on a podcast or read off a screenshot, not a clicked link.
function ReferralCodeEntry({ referralCode, pricing, onApply }) {
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
        <button type="button" onClick={() => setEditing(true)}
          className="underline font-normal text-emerald-700/80 hover:text-emerald-900">
          change
        </button>
      </p>
    )
  }

  return (
    <div className="flex items-center gap-2 mb-3">
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleApply()}
        placeholder="Have a referral code?"
        className="text-sm border border-gray-300 rounded-md px-3 py-1.5 w-52 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button type="button" onClick={handleApply}
        disabled={!value.trim()}
        className="text-sm font-medium text-blue-700 hover:underline disabled:opacity-40 disabled:no-underline">
        Apply
      </button>
    </div>
  )
}

export default function FixBanner({
  scan, onPay, onRedeemCredit, freeFixCredits = 0,
  referralCode = '', onApplyReferralCode = () => {}
}) {
  const navigate = useNavigate()
  const { byTier, pricing } = usePricing(referralCode)
  if (!scan || !['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status)) return null
  if (scan.fixPurchased) return null

  const score        = scan.atsScore ?? 0
  const badgeEligible = score >= 80
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
        <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} />
        <div className="flex flex-wrap gap-2 mt-3">
          {hasCredit && (
            <Button onClick={onRedeemCredit} variant="secondary">
              Use Free Credit
            </Button>
          )}
          <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary">
            Fix My Resume — <PriceTag tier="FIX_PLAIN" byTier={byTier} />
          </Button>
          <Button onClick={() => onPay('FIX')}>
            Fix + Verified Credential — <PriceTag tier="FIX" byTier={byTier} />
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
      <ReferralCodeEntry referralCode={referralCode} pricing={pricing} onApply={onApplyReferralCode} />
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={() => onPay('BADGE')} variant="secondary">
          Verified Credential only — <PriceTag tier="BADGE" byTier={byTier} />
        </Button>
        <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary">
          Fix My Resume, No Credential — <PriceTag tier="FIX_PLAIN" byTier={byTier} />
        </Button>
        {hasCredit && (
          <Button onClick={onRedeemCredit} variant="secondary">
            Full AI Fix — Free Credit
          </Button>
        )}
        <Button onClick={() => onPay('FIX')}>
          Full AI Fix + Credential — <PriceTag tier="FIX" byTier={byTier} />
        </Button>
      </div>
    </div>
  )
}
