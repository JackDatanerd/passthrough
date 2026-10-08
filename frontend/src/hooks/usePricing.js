import { useCallback, useContext, useEffect, useState } from 'react'
import api from '../lib/api'
import { AuthContext } from '../context/AuthContext'
import { formatMoney } from '../lib/utils'

// Fetches /api/pricing once per referral-code key and shares it across every
// component using that same key. Backend is the single source of truth for
// amount/originalAmount/promoActive/promoEndsAt/referralApplied — nothing
// here invents a price or a deadline.
//
// STANDARD_PRICES is the one exception, and deliberately so: it's the
// last-resort fallback if the fetch fails (network blip, brief deploy
// mismatch, etc). It mirrors constants.js's PRICE_FIX/PRICE_BADGE/
// PRICE_FIX_PLAIN — the non-promo, non-referral prices — so a failed fetch
// degrades to "correct standard price, no anchor/discount shown" rather
// than a bare placeholder that makes the page look broken.
export const STANDARD_PRICES = { FIX: 4900, BADGE: 3900, FIX_PLAIN: 3900 }

// CACHE EXPIRY (bug fix): this cache used to live forever. When a launch promo
// ended while a tab was open, <PromoCountdown> hid itself but the cached promo
// prices (and struck-through "was $X" anchors) stayed on screen — and checkout,
// which prices against the server clock, then charged the higher standard
// price. Entries now expire on a TTL, are treated as stale the instant the promo
// deadline passes, and each mounted hook schedules a refetch for that moment.
const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_AUTO_RETRIES = 4
const RETRY_BASE_MS = 10_000

// Keyed by VIEWER + referral code ('' = no code). A code changes what /api/pricing returns, so the
// no-code cache and a per-code cache can't share one slot — and so does WHO is asking: the server
// withholds a referral discount from the code's own owner (the self-referral guard, B11), so an
// anonymous quote of the discounted price is wrong for the same person once they log in.
// AUDIT FIX (Payments & Pricing round 3, bug — B3): the cache used to be keyed by code alone, so a
// partner who opened their own link logged out, then logged in without a reload, kept seeing the
// discounted price on the checkout button for up to the 5-minute TTL while checkout charged the
// standard one. Logging in or out (or switching accounts) now lands on a different slot.
const cacheByKey = {}     // `${viewer}|${code}` -> { data, fetchedAt, clockOffsetMs }
const inflightByKey = {}

function promoLapsed(entry) {
  const d = entry?.data
  if (!d?.promoActive || !d.promoEndsAt) return false
  const end = Date.parse(d.promoEndsAt)
  return Number.isFinite(end) && Date.now() + (entry.clockOffsetMs || 0) >= end
}

function isFresh(entry) {
  return !!entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS && !promoLapsed(entry)
}

function fetchPricing(key, code, { force = false } = {}) {
  if (!force && isFresh(cacheByKey[key])) return Promise.resolve(cacheByKey[key])
  if (!inflightByKey[key]) {
    const qs = code ? `?ref=${encodeURIComponent(code)}` : ''
    const startedAt = Date.now()
    inflightByKey[key] = api.get(`/pricing${qs}`).then(res => {
      const data = res.data.data
      // server time minus device time (measured at the request midpoint to
      // cancel out latency) — lets the countdown follow the SERVER clock.
      const clockOffsetMs = Number.isFinite(data?.serverTime)
        ? data.serverTime - (startedAt + Date.now()) / 2
        : 0
      cacheByKey[key] = { data, fetchedAt: Date.now(), clockOffsetMs }
      return cacheByKey[key]
    }).catch(() => null)
      .finally(() => { inflightByKey[key] = null })   // never stick — next mount retries
  }
  return inflightByKey[key]
}

// usePricing() — unchanged behavior for existing callers (e.g. Pricing.jsx).
// usePricing(referralCode) — resolves discounted pricing for that code;
// falls back to standard/promo pricing automatically if the code turns out
// to be invalid (that's the backend's job, not this hook's).
//
// Also returns `refresh()` and `clockOffsetMs` (see PromoCountdown).
export function usePricing(referralCode = '') {
  const code = referralCode ? referralCode.trim().toUpperCase() : ''
  // Null-safe on purpose (not useAuth(), which throws): this hook must keep working in a bare render.
  const viewer = useContext(AuthContext)?.user?.id ?? 'anon'
  const key = `${viewer}|${code}`
  const [entry, setEntry] = useState(cacheByKey[key] || null)
  const [failed, setFailed] = useState(false)
  // Consecutive failed fetches for this key — drives the bounded automatic retry below.
  const [failures, setFailures] = useState(0)

  const refresh = useCallback(() => {
    return fetchPricing(key, code, { force: true }).then(e => {
      if (e) { setEntry(e); setFailed(false); setFailures(0) }
      else {
        setFailed(true); setFailures(n => n + 1)
        // PAYMENTS & PRICING ROUND 6 (bug): when the refetch at the promo deadline failed, the expired
        // promo entry stayed on screen — struck-through prices and a discount nobody can get — right
        // beside a notice saying "showing standard pricing". A lapsed promo entry is dropped so byTier()
        // really does fall back to the standard price (the retry below then fetches the real answer).
        setEntry(cur => (cur && promoLapsed(cur) ? null : cur))
      }
    })
  }, [key, code])

  useEffect(() => {
    let cancelled = false
    // AUDIT FIX (Payments & Pricing pass 1, bug — B7): when the code changes
    // to a key that ISN'T cached, `entry` used to keep showing the OLD key's
    // prices (and its referralApplied) until the new fetch resolved — and, if
    // that fetch failed, forever, sitting right next to the failure notice.
    // Clearing to null for an uncached key means byTier() immediately falls
    // back to the correct STANDARD price while loading, and stays there (not
    // some other code's discounted price) if the fetch never comes back.
    if (cacheByKey[key]) setEntry(cacheByKey[key])
    else setEntry(null)
    fetchPricing(key, code).then(e => {
      if (cancelled) return
      if (e) { setEntry(e); setFailed(false); setFailures(0) } else { setFailed(true); setFailures(n => n + 1) }
    })
    return () => { cancelled = true }
  }, [key, code])

  // Round 6: a failed fetch used to be final until the next mount or tab-visibility change, so a brief
  // network blip at the promo deadline (or on first load) left the page on fallback prices for good.
  // Retry a few times with a growing wait, then stop — the failure notice's own Retry stays available.
  useEffect(() => {
    if (!failures || failures > MAX_AUTO_RETRIES) return undefined
    const t = setTimeout(refresh, RETRY_BASE_MS * failures)
    return () => clearTimeout(t)
  }, [failures, refresh])

  // Refetch at the instant the promo deadline passes.
  useEffect(() => {
    const d = entry?.data
    if (!d?.promoActive || !d.promoEndsAt) return undefined
    const end = Date.parse(d.promoEndsAt)
    if (!Number.isFinite(end)) return undefined
    const ms = end - (Date.now() + (entry.clockOffsetMs || 0)) + 750
    if (ms > 2_000_000_000) return undefined            // beyond setTimeout's range — the TTL covers it
    const t = setTimeout(refresh, Math.max(ms, 1000))
    return () => clearTimeout(t)
  }, [entry, refresh])

  // A tab left in the background past the TTL refreshes when it comes back.
  useEffect(() => {
    const onVisible = () => { if (!document.hidden && !isFresh(cacheByKey[key])) refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [key, refresh])

  const pricing = entry?.data || null

  const byTier = tier => {
    const live = pricing?.tiers?.find(t => t.tier === tier)
    if (live) return live
    // Fetch hasn't resolved yet, or failed — fall back to the correct
    // standard (non-promo, non-referral) price rather than showing nothing.
    return { tier, amount: STANDARD_PRICES[tier], originalAmount: STANDARD_PRICES[tier], referralApplied: false, discountApplied: false, selfReferral: false }
  }

  return { pricing, byTier, pricingFailed: failed, refresh, clockOffsetMs: entry?.clockOffsetMs || 0 }
}

// AUDIT FIX (bug): this used to hardcode `$` regardless of what /api/pricing
// actually returned in `data.currency` — the one formatter in the codebase
// that didn't respect it. pricing.controller.js and referral.service.js both
// carry dedicated audit comments (and referral.pricing.test.js has a test)
// specifically guarding against ever hardcoding USD, because the ACTUAL
// charge always defers to `env.PAYSTACK_CURRENCY || c.CURRENCY` — this was
// the one place downstream of that work that threw it away, and it's on the
// literal checkout buttons (FixBanner's PriceTag). Mirrors the
// already-correct pattern used elsewhere for money (lib/utils.js's
// formatMoney/formatCents, PartnerDashboard's fmtCents): USD gets a bare `$`
// for the common case, anything else gets a plain-number + currency-code
// suffix rather than a `$` that would misrepresent what's actually charged.
//
// SECTION 3/4 AUDIT FIX (bug): this used to be an unconditional toFixed(0),
// silently dropping any cents. Harmless while every hardcoded price is a
// round dollar, but partners.controller.js's tierPricesSchema only requires
// a positive integer of cents and PartnerDetail.jsx's price inputs are
// step="0.01", so a partner code CAN be priced at e.g. 2949 ($29.49) — this
// then showed "$29" (or "$30" for 2950) while Paystack charged the exact
// amount. Whole-dollar amounts keep the clean "$49" look; anything with real
// cents now renders exactly as formatCents does everywhere else.
export const fmtPrice = (cents, currency = 'USD') =>
  // One money formatter for the whole UI (lib/utils.js): same symbol/suffix rule and the same
  // thousands grouping as the admin and partner screens. Whole-dollar amounts drop the cents.
  formatMoney(cents, { currency, decimals: Number.isInteger(Number(cents) / 100) ? 0 : 2 })
