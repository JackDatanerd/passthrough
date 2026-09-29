import { useState } from 'react'

// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G5): this used to live only
// inside FixBanner.jsx (checkout), so a visitor with a code heard on a
// podcast or read off a screenshot — anyone who didn't arrive via a clicked
// ?ref= link — had no way to apply it until they'd already started a scan
// and reached checkout. Extracted here, unchanged, so Pricing.jsx (the page
// most likely to be that visitor's first stop) can offer the identical
// field, with the identical "doesn't look right" handling, instead of a
// second hand-written copy that could quietly drift from this one.
//
// Two states: a code is already applied (show the confirmation + a way to
// change it), or no code is applied yet (show the entry field).
export function ReferralCodeEntry({ referralCode, pricing, onApply, disabled }) {
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

  // A code that's set (typed and applied, or arrived pre-filled via a ?ref=
  // link) but that pricing reports back as NOT applied means the code
  // doesn't exist, is inactive, or has expired. `pricing` is null while
  // /api/pricing is still loading for this code — checking it explicitly
  // avoids flashing an error during that normal loading gap.
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

// usePricing()'s `pricingFailed` signal, surfaced with a one-click retry —
// "degrade quietly" (byTier()'s silent fallback to standard pricing) is the
// wrong default on a page that shows prices, since a failed fetch would
// otherwise look identical to a normal, no-discount load.
export function PricingFailedNotice({ referralCode, onRetry, className = 'text-xs mb-3' }) {
  return (
    <p className={`text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 ${className}`}>
      {referralCode
        ? "We couldn't verify your referral discount just now — showing standard pricing below. "
        : "We couldn't load current pricing just now — showing standard pricing below. "}
      <button type="button" onClick={onRetry} className="underline font-medium hover:text-amber-900">
        Try again
      </button>
    </p>
  )
}
