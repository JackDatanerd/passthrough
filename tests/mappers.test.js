import { describe, it, expect } from 'vitest'
import {
  userRowToCamel, scanRowToCamel, paymentRowToCamel, camelToSnake,
  partnerRowToCamel, payoutRowToCamel, referralCodeRowToCamel, commissionLedgerRowToCamel,
  leadRowToCamel,
  USER_FIELD_MAP, SCAN_FIELD_MAP, PAYMENT_FIELD_MAP, PARTNER_FIELD_MAP,
} from '../src/lib/mappers.js'

// mappers.js had zero direct test coverage despite sitting at the read/write
// boundary for every table in the app and, in partnerRowToCamel's case,
// being the thing responsible for NEVER leaking payout_details_token (a
// bearer secret) into a general partner-read response. That guarantee was
// resting entirely on the destructuring in the source and nothing verifying
// it stays that way.

describe('null passthrough', () => {
  const mappers = { userRowToCamel, scanRowToCamel, paymentRowToCamel, partnerRowToCamel, payoutRowToCamel, referralCodeRowToCamel, commissionLedgerRowToCamel, leadRowToCamel }
  for (const [name, fn] of Object.entries(mappers)) {
    it(`${name} returns null/undefined as-is instead of throwing`, () => {
      expect(fn(null)).toBe(null)
      expect(fn(undefined)).toBe(undefined)
    })
  }
})

describe('partnerRowToCamel', () => {
  const row = {
    id: 'p1', name: 'Acme', email: 'a@b.com', referral_code: 'ACME10', status: 'ACTIVE',
    commission_rate: '0.2500', payout_method: 'bank', payout_details: { iban: 'x' },
    payout_details_submitted_at: '2026-01-01', payout_details_token: 'super-secret-token',
    payouts: [{ id: 'pay1', partner_id: 'p1', amount_cents: 1000, currency: 'USD', payout_method: 'bank', status: 'PAID', created_at: 't' }],
    referral_codes: [{ id: 'rc1', partner_id: 'p1', code: 'ACME10', active: true, uses_so_far: 3, clicks: 10, created_at: 't' }],
    commission_ledger: [{ id: 'cl1', payment_id: 'pay1', partner_id: 'p1', gross_amount_cents: 2900, commission_rate: '0.2500', commission_amount_cents: 725, created_at: 't' }],
    created_at: 't1', updated_at: 't2',
  }

  it('never includes payout_details_token in the mapped output', () => {
    const mapped = partnerRowToCamel(row)
    expect(mapped).not.toHaveProperty('payoutDetailsToken')
    expect(mapped).not.toHaveProperty('payout_details_token')
    expect(JSON.stringify(mapped)).not.toContain('super-secret-token')
  })

  it('converts the numeric-as-string commissionRate to a real number', () => {
    expect(partnerRowToCamel(row).commissionRate).toBe(0.25)
  })

  it('treats a null commissionRate as null, not NaN', () => {
    expect(partnerRowToCamel({ ...row, commission_rate: null }).commissionRate).toBe(null)
  })

  it('recursively maps nested payouts / referral_codes / commission_ledger', () => {
    const mapped = partnerRowToCamel(row)
    expect(mapped.payouts[0]).toMatchObject({ id: 'pay1', partnerId: 'p1', amountCents: 1000 })
    expect(mapped.referralCodes[0]).toMatchObject({ id: 'rc1', usesSoFar: 3 })
    expect(mapped.commissionLedger[0]).toMatchObject({ id: 'cl1', grossAmountCents: 2900, commissionRate: 0.25 })
  })

  it('leaves nested collections undefined when the row has none (not an error, not [])', () => {
    const bare = { id: 'p1', name: 'x', email: 'x', referral_code: 'x', status: 'ACTIVE', commission_rate: null, created_at: 't', updated_at: 't' }
    const mapped = partnerRowToCamel(bare)
    expect(mapped.payouts).toBeUndefined()
    expect(mapped.referralCodes).toBeUndefined()
    expect(mapped.commissionLedger).toBeUndefined()
  })
})

describe('commissionLedgerRowToCamel', () => {
  it('converts numeric-as-string commissionRate the same way partnerRowToCamel does', () => {
    expect(commissionLedgerRowToCamel({ commission_rate: '0.3000' }).commissionRate).toBe(0.3)
    expect(commissionLedgerRowToCamel({ commission_rate: null }).commissionRate).toBe(null)
  })

  it('defaults reversesLedgerId/reversalReason to null rather than undefined', () => {
    const mapped = commissionLedgerRowToCamel({ id: 'cl1' })
    expect(mapped.reversesLedgerId).toBe(null)
    expect(mapped.reversalReason).toBe(null)
  })
})

describe('camelToSnake', () => {
  it('only emits keys actually present on the input object (partial-update safe)', () => {
    const out = camelToSnake({ status: 'ACTIVE' }, USER_FIELD_MAP)
    expect(out).toEqual({ status: 'ACTIVE' })
  })

  it('maps every USER_FIELD_MAP key when all are present', () => {
    const input = Object.fromEntries(Object.keys(USER_FIELD_MAP).map(k => [k, `v_${k}`]))
    const out = camelToSnake(input, USER_FIELD_MAP)
    for (const [camel, snake] of Object.entries(USER_FIELD_MAP)) {
      expect(out[snake]).toBe(`v_${camel}`)
    }
  })

  it('does not emit a key whose value is explicitly undefined but not own-present... (present with value undefined IS emitted)', () => {
    // hasOwnProperty is true here even though the value is undefined —
    // camelToSnake is presence-based, not truthiness-based, by design (so a
    // caller can explicitly null out a field).
    const out = camelToSnake({ status: undefined }, USER_FIELD_MAP)
    expect(out).toEqual({ status: undefined })
    expect(Object.prototype.hasOwnProperty.call(out, 'status')).toBe(true)
  })

  it('ignores keys not present in the field map', () => {
    const out = camelToSnake({ status: 'ACTIVE', notAMappedField: 'x' }, USER_FIELD_MAP)
    expect(out).toEqual({ status: 'ACTIVE' })
  })

  it('SCAN_FIELD_MAP / PAYMENT_FIELD_MAP / PARTNER_FIELD_MAP round-trip a representative field each', () => {
    expect(camelToSnake({ atsScore: 80 }, SCAN_FIELD_MAP)).toEqual({ ats_score: 80 })
    expect(camelToSnake({ fixTier: 'FIX' }, PAYMENT_FIELD_MAP)).toEqual({ fix_tier: 'FIX' })
    expect(camelToSnake({ commissionRate: 0.3 }, PARTNER_FIELD_MAP)).toEqual({ commission_rate: 0.3 })
  })
})

describe('userRowToCamel / scanRowToCamel / paymentRowToCamel / leadRowToCamel', () => {
  it('userRowToCamel maps a representative sample of fields', () => {
    const mapped = userRowToCamel({
      id: 'u1', email: 'a@b.com', password_hash: 'h', role: 'USER', status: 'ACTIVE',
      email_verified: true, scans_today: 2, free_fix_credits: 1,
      paystack_customer_code: 'CUS_1', saved_profile: { name: 'A' },
      created_at: 't1', updated_at: 't2',
    })
    expect(mapped).toMatchObject({
      id: 'u1', email: 'a@b.com', passwordHash: 'h', role: 'USER', status: 'ACTIVE',
      emailVerified: true, scansToday: 2, freeFixCredits: 1,
      paystackCustomerCode: 'CUS_1', savedProfile: { name: 'A' },
    })
  })

  it('scanRowToCamel maps id/status/scores and the brain-dump fields', () => {
    const mapped = scanRowToCamel({
      id: 's1', status: 'COMPLETE_PASS', ats_score: 82, passed: true,
      input_mode: 'brainDump', contact_name: 'Jo', contact_email: 'jo@x.com',
      raw_brain_dump_text: 'text', created_at: 't1', updated_at: 't2',
    })
    expect(mapped).toMatchObject({
      id: 's1', status: 'COMPLETE_PASS', atsScore: 82, passed: true,
      inputMode: 'brainDump', contactName: 'Jo', contactEmail: 'jo@x.com', rawBrainDumpText: 'text',
    })
  })

  it('paymentRowToCamel includes fixTier and referralCode (Section 9 fix)', () => {
    const mapped = paymentRowToCamel({
      id: 'pay1', amount_cents: 2900, currency: 'USD', status: 'SUCCESS',
      fix_tier: 'FIX', referral_code_id: 'rc1', referral_code: 'ACME10',
      user_id: 'u1', scan_id: 's1', created_at: 't1', updated_at: 't2',
    })
    expect(mapped).toMatchObject({ fixTier: 'FIX', referralCodeId: 'rc1', referralCode: 'ACME10' })
  })

  it('leadRowToCamel defaults sourceCode to null when absent', () => {
    expect(leadRowToCamel({ id: 'l1', name: 'A', company: 'B', email: 'c@d.com', source: 'homepage' }).sourceCode).toBe(null)
  })
})
