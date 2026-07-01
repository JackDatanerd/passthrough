import { useNavigate } from 'react-router-dom'
import Button from '../ui/Button'

export default function FixBanner({ scan, onPay }) {
  const navigate = useNavigate()
  if (!scan || !['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status)) return null
  if (scan.fixPurchased) return null

  const score        = scan.atsScore ?? 0
  const badgeEligible = score >= 80

  // <75 or 75-79: only $49 fix available
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
            Full AI rewrite + ATS-optimised .docx + beautiful PDF + Passthrough Verified credential
          </p>
        </div>
        <Button onClick={() => onPay('FIX')} className="shrink-0">
          Fix My Resume — $49
        </Button>
      </div>
    )
  }

  // 80+: badge ($15) or full fix ($49)
  return (
    <div className="rounded-lg border border-green-200 bg-green-50 p-5">
      <p className="font-semibold text-green-900 mb-1">
        ✓ Your resume passed ATS — you're Verified-eligible
      </p>
      <p className="text-sm text-green-800 mb-4">
        Get the Passthrough Verified credential employers can check, or upgrade to the full AI rewrite.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button onClick={() => onPay('BADGE')} variant="secondary">
          Verified Credential only — $39
        </Button>
        <Button onClick={() => onPay('FIX')}>
          Full AI Fix + Credential — $49
        </Button>
      </div>
    </div>
  )
}
