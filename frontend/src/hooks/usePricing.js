import { useEffect, useState } from 'react'
import api from '../lib/api'

// Fetches /api/pricing once and shares it across every component that calls
// this hook. Backend is the single source of truth for amount/originalAmount/
// promoActive/promoEndsAt — nothing here invents a price or a deadline.
//
// STANDARD_PRICES is the one exception, and deliberately so: it's the
// last-resort fallback if the fetch fails (network blip, brief deploy
// mismatch, etc). It mirrors constants.js's PRICE_FIX/PRICE_BADGE/
// PRICE_FIX_PLAIN — the non-promo prices — so a failed fetch degrades to
// "correct standard price, no anchor/slash shown" rather than a bare
// placeholder that makes the page look broken. It never invents a promo
// price, since this is the one path where the frontend can't confirm what
// the backend would actually charge.
export const STANDARD_PRICES = { FIX: 4900, BADGE: 3900, FIX_PLAIN: 3900 }

let cache = null
let inflight = null
let failedOnce = false

function fetchPricing() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = api.get('/pricing').then(res => {
      cache = res.data.data
      failedOnce = false
      return cache
    }).catch(() => {
      failedOnce = true
      inflight = null   // don't stick permanently — next mount retries
      return null
    })
  }
  return inflight
}

export function usePricing() {
  const [pricing, setPricing] = useState(cache)

  useEffect(() => {
    if (!cache) fetchPricing().then(setPricing)
  }, [])

  const byTier = tier => {
    const live = pricing?.tiers.find(t => t.tier === tier)
    if (live) return live
    // Fetch hasn't resolved yet, or failed — fall back to the correct
    // standard (non-promo) price rather than showing nothing.
    return { tier, amount: STANDARD_PRICES[tier], originalAmount: STANDARD_PRICES[tier] }
  }

  return { pricing, byTier, pricingFailed: failedOnce }
}

export const fmtPrice = cents => `$${(cents / 100).toFixed(0)}`
