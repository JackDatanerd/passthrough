import { useEffect, useState } from 'react'
import Input from './Input'
import Button from './Button'

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

  // The parent can set the code after mount (a ?ref= link captured late) or
  // normalise what was typed (trim / casing). Follow it so the field never keeps
  // showing text the page has since replaced.
  useEffect(() => {
    setValue(referralCode || '')
    if (referralCode) setEditing(false)
  }, [referralCode])

  // Apply needs a real code: Enter on a blank field used to call onApply('') —
  // silently wiping an applied code, while the Apply button itself was disabled
  // for blank. Clearing is now its own explicit action (handleRemove).
  function handleApply() {
    const code = value.trim()
    if (!code || disabled) return
    onApply(code)
    setEditing(false)
  }

  function handleRemove() {
    setValue('')
    onApply('')
    setEditing(true)
  }

  if (referralCode && pricing?.referralApplied && !editing) {
    // AUDIT FIX (Payments & Pricing round 2, bug — B2): referralApplied means
    // the code is IN EFFECT (partner attribution), not that it saved the buyer
    // anything — when the site promo already beats the code's price, the code
    // is attributed but the price is the same one everybody pays. discountApplied
    // (pricing.controller.js, added by the earlier B8 fix but never read by any
    // UI) is the signal "you got a discount" copy must hang on.
    const saves = pricing.discountApplied !== false   // older/cached responses without the field keep the old wording
    return (
      <p className="text-sm font-medium text-emerald-700 mb-3">
        {saves
          ? <>✓ Referral code <span className="font-mono">{referralCode}</span> applied —{' '}</>
          : <>✓ Referral code <span className="font-mono">{referralCode}</span> recognised — today's price is already as low as your code's, so it doesn't change what you pay.{' '}</>}
        <button type="button" onClick={() => setEditing(true)} disabled={disabled}
          className="underline font-normal text-emerald-700/80 hover:text-emerald-900 disabled:opacity-40 disabled:no-underline">
          change
        </button>
        {' '}
        <button type="button" onClick={handleRemove} disabled={disabled}
          className="underline font-normal text-emerald-700/80 hover:text-emerald-900 disabled:opacity-40 disabled:no-underline">
          remove
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
  // A partner's own code on their own account is refused on purpose (it would
  // be a discount AND a commission on the same sale). Say that, rather than
  // implying the code is mistyped.
  const selfReferral = invalid && pricing.selfReferral === true

  const invalidMessage = !invalid ? undefined : selfReferral
    ? "Partner codes can't be used on your own purchases — clear it to continue at the regular price."
    : "That code doesn't look right — check it and try again, or leave it blank."

  return (
    <div className="mb-3 flex items-start gap-2 flex-wrap">
      <Input
        aria-label="Referral code"
        placeholder="Have a referral code?"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          // isComposing: Enter that merely confirms an IME candidate must not apply the code
          if (e.key === 'Enter' && !e.nativeEvent?.isComposing) { e.preventDefault(); handleApply() }
        }}
        error={invalidMessage}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        wrapperClassName="w-60 max-w-full"
      />
      <Button type="button" size="sm" variant="secondary" onClick={handleApply}
        disabled={!value.trim() || disabled} className="mt-0.5">
        Apply
      </Button>
      {referralCode && (
        <Button type="button" size="sm" variant="ghost" onClick={handleRemove} disabled={disabled} className="mt-0.5">
          Remove
        </Button>
      )}
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
