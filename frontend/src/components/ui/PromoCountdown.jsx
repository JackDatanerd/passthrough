import { useEffect, useState } from 'react'

// Ticks down to a real, server-provided deadline. Callers should only
// render this when pricing.promoActive is true and promoEndsAt is set —
// there's no internal fallback date, by design, so there's no path where a
// stale or invented deadline gets shown.
export default function PromoCountdown({ endsAt, className = '' }) {
  const [remaining, setRemaining] = useState(() => Date.parse(endsAt) - Date.now())

  useEffect(() => {
    const id = setInterval(() => setRemaining(Date.parse(endsAt) - Date.now()), 1000)
    return () => clearInterval(id)
  }, [endsAt])

  if (remaining <= 0) return null

  const h = Math.floor(remaining / 3_600_000)
  const m = Math.floor((remaining % 3_600_000) / 60_000)
  const s = Math.floor((remaining % 60_000) / 1000)
  const pad = n => String(n).padStart(2, '0')

  return (
    <div className={`inline-flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm font-medium px-4 py-2 rounded-full ${className}`}>
      Launch pricing ends in {pad(h)}:{pad(m)}:{pad(s)}
    </div>
  )
}
