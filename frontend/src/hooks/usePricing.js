import { useEffect, useState } from 'react'
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

// Keyed by referral code ('' = no code) — a code changes what /api/pricing
// returns, so the no-code cache and a per-code cache can't share one slot.
const cacheByKey = {}
const inflightByKey = {}
let failedOnce = false

function fetchPricing(key) {
  if (cacheByKey[key]) return Promise.resolve(cacheByKey[key])
  if (!inflightByKey[key]) {
    const qs = key ? `?ref=${encodeURIComponent(key)}` : ''
    inflightByKey[key] = api.get(`/pricing${qs}`).then(res => {
      cacheByKey[key] = res.data.data
      failedOnce = false
      return cacheByKey[key]
    }).catch(() => {
      failedOnce = true
      inflightByKey[key] = null   // don't stick permanently — next mount retries
      return null
    })
  }
  return inflightByKey[key]
}

// usePricing() — unchanged behavior for existing callers (e.g. Pricing.jsx).
// usePricing(referralCode) — resolves discounted pricing for that code;
// falls back to standard/promo pricing automatically if the code turns out
// to be invalid (that's the backend's job, not this hook's).
export function usePricing(referralCode = '') {
  const key = referralCode ? referralCode.trim().toUpperCase() : ''
  const [pricing, setPricing] = useState(cacheByKey[key] || null)

  useEffect(() => {
    if (cacheByKey[key]) { setPricing(cacheByKey[key]); return }
    fetchPricing(key).then(setPricing)
  }, [key])

  const byTier = tier => {
    const live = pricing?.tiers.find(t => t.tier === tier)
    if (live) return live
    // Fetch hasn't resolved yet, or failed — fall back to the correct
    // standard (non-promo, non-referral) price rather than showing nothing.
    return { tier, amount: STANDARD_PRICES[tier], originalAmount: STANDARD_PRICES[tier], referralApplied: false }
  }

  return { pricing, byTier, pricingFailed: failedOnce }
}

export const fmtPrice = cents => `$${(cents / 100).toFixed(0)}`
