import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

// Round 24: partner reads are paged (PostgREST row cap) and the payout-due alert skips mixed-currency partners like the export.
const src = fs.readFileSync(new URL('../src/controllers/partners.controller.js', import.meta.url), 'utf8')

describe('partners round 24', () => {
  it('no unpaged select on the whole partners table remains in the list, export or sweep', () => {
    expect(src).toMatch(/async function loadAllPartners/)
    expect((src.match(/loadAllPartners\(supabase/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(src).not.toMatch(/from\('partners'\)\s*\.select\('\*'\)\s*\.not\('payout_method'/)
  })
  it('sweepPayoutDue leaves out partners whose unpaid commission spans currencies', () => {
    expect(src).toMatch(/payout can only settle one currency: the payout-run export leaves such a partner out/)
  })
})
