// @vitest-environment jsdom
// Partners round 23: ENDED partners are not counted for the terms notice; the code edit modal can rename.
import { describe, it, expect } from 'vitest'
import { PARTNER_FILTERS } from '../src/pages/admin/AdminPartners'

describe('terms filter (bug 2)', () => {
  const base = { email: 'a@x.co', termsCurrent: false }
  it('lists active/paused partners who have not accepted, but not ended ones', () => {
    expect(PARTNER_FILTERS.terms.test({ ...base, status: 'ACTIVE' })).toBe(true)
    expect(PARTNER_FILTERS.terms.test({ ...base, status: 'PAUSED' })).toBe(true)
    expect(PARTNER_FILTERS.terms.test({ ...base, status: 'ENDED' })).toBe(false)
  })
})
