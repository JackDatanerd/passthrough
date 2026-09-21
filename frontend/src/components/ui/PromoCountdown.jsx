import { useEffect, useRef, useState } from 'react'

// Ticks down to a real, server-provided deadline. Callers should only
// render this when pricing.promoActive is true and promoEndsAt is set —
// there's no internal fallback date, by design, so there's no path where a
// stale or invented deadline gets shown.
//
// Changes vs. the original:
//  - `clockOffsetMs` (server time minus device time, from /api/pricing's
//    serverTime): the deadline is enforced against the SERVER clock at checkout,
//    so a device with a wrong clock used to show a countdown that lied.
//  - `onExpire` fires once when the deadline passes, so the page can refetch
//    pricing. Without it the countdown quietly disappeared while the cached promo
//    prices stayed on screen — and checkout then charged the higher standard price.
//  - An unparseable `endsAt` renders nothing instead of "NaN:NaN:NaN".
//  - Multi-day deadlines read "2d 03:04:05" rather than "51:04:05".
//  - The interval stops after expiry instead of ticking forever.
function computeRemaining(endsAt, offsetMs) {
  const end = Date.parse(endsAt)
  return Number.isFinite(end) ? end - (Date.now() + offsetMs) : null
}

export default function PromoCountdown({ endsAt, clockOffsetMs = 0, onExpire, className = '' }) {
  const [remaining, setRemaining] = useState(() => computeRemaining(endsAt, clockOffsetMs))
  const expiredRef = useRef(false)
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire

  useEffect(() => {
    expiredRef.current = false
    const tick = () => {
      const r = computeRemaining(endsAt, clockOffsetMs)
      setRemaining(r)
      if (r !== null && r <= 0 && !expiredRef.current) {
        expiredRef.current = true
        clearInterval(id)
        onExpireRef.current?.()
      }
    }
    const id = setInterval(tick, 1000)
    tick()
    return () => clearInterval(id)
  }, [endsAt, clockOffsetMs])

  if (remaining === null || remaining <= 0) return null

  const days = Math.floor(remaining / 86_400_000)
  const h = Math.floor((remaining % 86_400_000) / 3_600_000)
  const m = Math.floor((remaining % 3_600_000) / 60_000)
  const s = Math.floor((remaining % 60_000) / 1000)
  const pad = n => String(n).padStart(2, '0')

  return (
    <div
      role="timer"
      className={`inline-flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-sm font-medium px-4 py-2 rounded-full ${className}`}
    >
      Launch pricing ends in {days > 0 ? `${days}d ` : ''}{pad(h)}:{pad(m)}:{pad(s)}
    </div>
  )
}
