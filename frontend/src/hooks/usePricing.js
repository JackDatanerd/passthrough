import { useCallback, useEffect, useState } from 'react'
import api from '../lib/api'

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

// Keyed by referral code ('' = no code) — a code changes what /api/pricing
// returns, so the no-code cache and a per-code cache can't share one slot.
const cacheByKey = {}     // key -> { data, fetchedAt, clockOffsetMs }
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

function fetchPricing(key, { force = false } = {}) {
  if (!force && isFresh(cacheByKey[key])) return Promise.resolve(cacheByKey[key])
  if (!inflightByKey[key]) {
    const qs = key ? `?ref=${encodeURIComponent(key)}` : ''
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
  const key = referralCode ? referralCode.trim().toUpperCase() : ''
  const [entry, setEntry] = useState(cacheByKey[key] || null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    return fetchPricing(key, { force: true }).then(e => {
      if (e) { setEntry(e); setFailed(false) } else setFailed(true)
    })
  }, [key])

  useEffect(() => {
    let cancelled = false
    if (cacheByKey[key]) setEntry(cacheByKey[key])
    fetchPricing(key).then(e => {
      if (cancelled) return
      if (e) { setEntry(e); setFailed(false) } else setFailed(true)
    })
    return () => { cancelled = true }
  }, [key])

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
    return { tier, amount: STANDARD_PRICES[tier], originalAmount: STANDARD_PRICES[tier], referralApplied: false }
  }

  return { pricing, byTier, pricingFailed: failed, refresh, clockOffsetMs: entry?.clockOffsetMs || 0 }
}

export const fmtPrice = cents => `$${(cents / 100).toFixed(0)}`
