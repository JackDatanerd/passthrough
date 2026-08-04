import { useEffect, useState } from 'react'
import api from '../lib/api'

// Fetches /api/pricing once and shares it across every component that calls
// this hook. Backend is the single source of truth for amount/originalAmount/
// promoActive/promoEndsAt — nothing here invents a price or a deadline.
let cache = null
let inflight = null

function fetchPricing() {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = api.get('/pricing').then(res => {
      cache = res.data.data
      return cache
    }).catch(() => null)
  }
  return inflight
}

export function usePricing() {
  const [pricing, setPricing] = useState(cache)

  useEffect(() => {
    if (!cache) fetchPricing().then(setPricing)
  }, [])

  const byTier = tier => pricing?.tiers.find(t => t.tier === tier)

  return { pricing, byTier }
}

export const fmtPrice = cents => `$${(cents / 100).toFixed(0)}`
