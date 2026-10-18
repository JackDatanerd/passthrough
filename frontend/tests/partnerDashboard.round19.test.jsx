// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from "node:fs"
import { fileURLToPath } from "node:url"

// Source-level guard: the raw ledger reason codes must never be printed to a partner.
describe('partner dashboard reversal wording (round 19)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/pages/PartnerDashboard.jsx', import.meta.url)), "utf8")
  it('maps reason codes to words instead of printing them', () => {
    expect(src).not.toMatch(/Refunded\{conversion\.reversalReason/)
    expect(src).toMatch(/ADMIN_REVERSED: 'Reversed by Passthrough'/)
    expect(src).toMatch(/reversalLabel\(conversion\.reversalReason\)/)
  })
})
