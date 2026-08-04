import { useNavigate } from 'react-router-dom'
import Button from '../ui/Button'
import { usePricing, fmtPrice } from '../../hooks/usePricing'

// PriceTag falls back to the hardcoded standard price if /api/pricing hasn't
// loaded yet (fast first paint) or failed to load (fails safe to the correct
// non-promo price rather than showing nothing or a wrong number).
function PriceTag({ tier, fallbackCents, byTier }) {
  const live = byTier(tier)
  if (!live) return <>{fmtPrice(fallbackCents)}</>
  const onPromo = live.amount !== live.originalAmount
  return (
    <>
      {onPromo && <s className="opacity-60 mr-1">{fmtPrice(live.originalAmount)}</s>}
      {fmtPrice(live.amount)}
    </>
  )
}

export default function FixBanner({ scan, onPay, onRedeemCredit, freeFixCredits = 0 }) {
  const navigate = useNavigate()
  const { byTier } = usePricing()
  if (!scan || !['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status)) return null
  if (scan.fixPurchased) return null

  const score        = scan.atsScore ?? 0
  const badgeEligible = score >= 80
  const hasCredit      = freeFixCredits > 0

  // <75 or 75-79: full fix ($49), or just the rewrite with no credential ($39)
  // (standard prices — see /api/pricing for live/promo amounts)
  if (!badgeEligible) {
    return (
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-blue-900">
            {score < 75
              ? 'Your resume is being rejected by ATS filters'
              : 'Boost your score and unlock Verified status'}
          </p>
          <p className="text-sm text-blue-700 mt-1">
            Full AI rewrite + ATS-optimised .docx + beautiful PDF — with or without the Passthrough Verified credential
          </p>
          {hasCredit && (
            <p className="text-sm text-green-700 mt-1 font-medium">
              You have {freeFixCredits} free fix credit{freeFixCredits > 1 ? 's' : ''} — use one below at no charge.
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          {hasCredit && (
            <Button onClick={onRedeemCredit} variant="secondary">
              Use Free Credit
            </Button>
          )}
          <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary">
            Fix My Resume — <PriceTag tier="FIX_PLAIN" fallbackCents={3900} byTier={byTier} />
          </Button>
          <Button onClick={() => onPay('FIX')}>
            Fix + Verified Credential — <PriceTag tier="FIX" fallbackCents={4900} byTier={byTier} />
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
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={() => onPay('BADGE')} variant="secondary">
          Verified Credential only — <PriceTag tier="BADGE" fallbackCents={3900} byTier={byTier} />
        </Button>
        <Button onClick={() => onPay('FIX_PLAIN')} variant="secondary">
          Fix My Resume, No Credential — <PriceTag tier="FIX_PLAIN" fallbackCents={3900} byTier={byTier} />
        </Button>
        {hasCredit && (
          <Button onClick={onRedeemCredit} variant="secondary">
            Full AI Fix — Free Credit
          </Button>
        )}
        <Button onClick={() => onPay('FIX')}>
          Full AI Fix + Credential — <PriceTag tier="FIX" fallbackCents={4900} byTier={byTier} />
        </Button>
      </div>
    </div>
  )
}
