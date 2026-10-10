import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const c = require('../src/config/constants.js')

// Payments & Pricing round 9 (G2): usePricing.js keeps a typed copy of the standard prices as the
// last-resort fallback when /api/pricing can't be reached. A copy can drift silently when a price is
// changed in constants.js — this makes that a failing test instead of a wrong number on screen.
describe('frontend STANDARD_PRICES fallback mirrors constants.js', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/src/hooks/usePricing.js'), 'utf8')
  const m = src.match(/export const STANDARD_PRICES = \{([^}]*)\}/)
  const parsed = Object.fromEntries((m?.[1] || '').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => { const [k, v] = x.split(':').map(y => y.trim()); return [k, Number(v)] }))
  it('finds the object', () => expect(Object.keys(parsed).sort()).toEqual(['BADGE', 'FIX', 'FIX_PLAIN']))
  it.each(['FIX', 'BADGE', 'FIX_PLAIN'])('%s matches the backend standard price', tier => {
    expect(parsed[tier]).toBe(c.standardPriceForTier(tier))
  })
})
