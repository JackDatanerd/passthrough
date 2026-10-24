import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import rails from '../src/lib/payoutRails.js'
import * as clientRails from '../frontend/src/lib/payoutRails.js'

// Western-market round: partners anywhere get paid. Bank details carry the routing code of the country the account is held in
// (US ACH, UK sort code, AU BSB, CA transit, IBAN, SWIFT/BIC), and PayPal is a payout method of its own.

let t
afterEach(() => t?.restore())

describe('validators', () => {
  it('ABA routing numbers are checked by checksum, not just length', () => {
    expect(rails.validAbaRouting('021000021')).toBe(true)      // a real, published routing number
    expect(rails.validAbaRouting('021 000 021')).toBe(true)
    expect(rails.validAbaRouting('021000022')).toBe(false)
    expect(rails.validAbaRouting('12345678')).toBe(false)
  })
  it('IBANs are checked with mod-97', () => {
    expect(rails.validIban('DE89 3704 0044 0532 0130 00')).toBe(true)
    expect(rails.validIban('GB82 WEST 1234 5698 7654 32')).toBe(true)
    expect(rails.validIban('DE89 3704 0044 0532 0130 01')).toBe(false)
    expect(rails.validIban('not an iban')).toBe(false)
  })
  it('SWIFT/BIC takes 8 or 11 characters', () => {
    expect(rails.validSwiftBic('CHASUS33')).toBe(true)
    expect(rails.validSwiftBic('CHASUS33XXX')).toBe(true)
    expect(rails.validSwiftBic('CHASUS3')).toBe(false)
  })
  it('the browser copy agrees with the server copy', () => {
    for (const v of ['021000021', '021000022', '12345678']) expect(clientRails.validAbaRouting(v)).toBe(rails.validAbaRouting(v))
    for (const v of ['DE89 3704 0044 0532 0130 00', 'DE89 3704 0044 0532 0130 01', 'GB82WEST12345698765432']) expect(clientRails.validIban(v)).toBe(rails.validIban(v))
  })
  it('masks a PayPal email down to its first letter and domain', () => {
    expect(rails.maskedEmail('alex.morgan@example.com')).toBe('a***@example.com')
    expect(rails.maskedEmail('nonsense')).toBe('')
  })
})

describe('bankRailProblems', () => {
  const base = { bankName: 'Chase', accountName: 'Alex Morgan' }
  const problems = d => rails.bankRailProblems({ ...base, ...d }).map(p => p.path)
  it('no country keeps the old free-form behaviour', () => {
    expect(problems({ accountNumber: '12345678' })).toEqual([])
  })
  it('US needs a valid ACH routing number and a numeric account', () => {
    expect(problems({ bankCountry: 'US', routingCode: '021000021', accountNumber: '000123456789' })).toEqual([])
    expect(problems({ bankCountry: 'US', accountNumber: '000123456789' })).toEqual(['routingCode'])
    expect(problems({ bankCountry: 'US', routingCode: '021000022', accountNumber: '000123456789' })).toEqual(['routingCode'])
    expect(problems({ bankCountry: 'US', routingCode: '021000021', accountNumber: 'ABCD1234' })).toEqual(['accountNumber'])
  })
  it('UK takes a sort code + account number, or an IBAN', () => {
    expect(problems({ bankCountry: 'GB', routingCode: '20-00-00', accountNumber: '55779911' })).toEqual([])
    expect(problems({ bankCountry: 'GB', accountNumber: 'GB82 WEST 1234 5698 7654 32' })).toEqual([])
    expect(problems({ bankCountry: 'GB', accountNumber: '55779911' })).toEqual(['routingCode'])
  })
  it('Australia needs a BSB and Canada transit + institution', () => {
    expect(problems({ bankCountry: 'AU', routingCode: '062-000', accountNumber: '12345678' })).toEqual([])
    expect(problems({ bankCountry: 'CA', routingCode: '12345-678', accountNumber: '1234567' })).toEqual([])
    expect(problems({ bankCountry: 'CA', routingCode: '12345', accountNumber: '1234567' })).toEqual(['routingCode'])
  })
  it('an IBAN country needs a valid IBAN that starts with the same country', () => {
    expect(problems({ bankCountry: 'DE', accountNumber: 'DE89 3704 0044 0532 0130 00' })).toEqual([])
    expect(problems({ bankCountry: 'DE', accountNumber: 'DE89 3704 0044 0532 0130 01' })).toEqual(['accountNumber'])
    expect(problems({ bankCountry: 'FR', accountNumber: 'DE89 3704 0044 0532 0130 00' })).toEqual(['accountNumber'])
  })
  it('any other country needs a SWIFT/BIC', () => {
    expect(problems({ bankCountry: 'SG', accountNumber: '1234567890' })).toEqual(['swiftBic'])
    expect(problems({ bankCountry: 'SG', accountNumber: '1234567890', swiftBic: 'DBSSSGSG' })).toEqual([])
    expect(problems({ bankCountry: 'US', routingCode: '021000021', accountNumber: '000123456789', swiftBic: 'bad' })).toEqual(['swiftBic'])
  })
})

describe('submitPayoutDetails with the new rails', () => {
  function setup(opts = {}) {
    const state = { patch: null, alerts: [] }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: opts.previous === undefined ? { payout_method: null, payout_details: null } : opts.previous, error: null }
      if (q.table === 'partners' && q.op === 'update') return (state.patch = q.patch, { data: { name: 'Alex', email: 'alex@x.co' }, error: null })
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPayoutDetailsChanged: async () => true, sendOwnerAlert: async (...a) => { state.alerts.push(a) } },
    })
    const c = body => ({ env: {}, req: { query: () => 'tok123', json: async () => body }, header: () => {}, json: (b, status = 200) => ({ body: b, status }) })
    return { mod, restore, state, c }
  }
  const US = { payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'us', routingCode: '021000021' }

  it('stores a US bank account with its routing number and country', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c(US))
    expect(t.state.patch.payout_method).toBe('BANK')
    expect(t.state.patch.payout_details).toEqual({ bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'US', routingCode: '021000021' })
  })
  it('refuses a US account with a mistyped routing number', async () => {
    t = setup()
    await expect(t.mod.submitPayoutDetails(t.c({ ...US, routingCode: '021000022' }))).rejects.toThrow()
    expect(t.state.patch).toBe(null)
  })
  it('stores a German account as its IBAN', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'BANK', bankName: 'Commerzbank', accountName: 'Jonas Weber', accountNumber: 'DE89 3704 0044 0532 0130 00', bankCountry: 'DE' }))
    expect(t.state.patch.payout_details.accountNumber).toBe('DE89 3704 0044 0532 0130 00')
  })
  it('accepts PayPal and stores the email', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'PAYPAL', accountName: 'Alex Morgan', paypalEmail: ' alex.morgan@example.com ' }))
    expect(t.state.patch.payout_method).toBe('PAYPAL')
    expect(t.state.patch.payout_details).toEqual({ accountName: 'Alex Morgan', paypalEmail: 'alex.morgan@example.com' })
  })
  it('refuses a PayPal submission without a valid email', async () => {
    t = setup()
    await expect(t.mod.submitPayoutDetails(t.c({ payoutMethod: 'PAYPAL', accountName: 'Alex', paypalEmail: 'not-an-email' }))).rejects.toThrow()
  })
  it('the owner alert names PayPal with a masked email, never the whole address', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'PAYPAL', accountName: 'Alex Morgan', paypalEmail: 'alex.morgan@example.com' }))
    const body = t.state.alerts[0][2]
    expect(body).toContain('PAYPAL a***@example.com')
    expect(body).not.toContain('alex.morgan@example.com')
  })
  it('mobile money still works for partners who use it', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ payoutMethod: 'MOBILE_MONEY', provider: 'M-Pesa', accountName: 'Alex', phoneNumber: '+1 415 555 0132' }))
    expect(t.state.patch.payout_method).toBe('MOBILE_MONEY')
  })
})

// Independent re-audit round: stray fields, empty strings, UK roll numbers and New Zealand.
describe('stray and empty fields (re-audit)', () => {
  const base = { payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789' }
  function setup(previous) {
    const state = { patch: null, updates: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: previous ?? { payout_method: null, payout_details: null }, error: null }
      if (q.table === 'partners' && q.op === 'update') return (state.updates++, state.patch = q.patch, { data: { name: 'Alex', email: 'alex@x.co' }, error: null })
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPayoutDetailsChanged: async () => true, sendOwnerAlert: async () => true },
    })
    const c = body => ({ env: {}, req: { query: () => 'tok123', json: async () => body }, header: () => {}, json: (b, status = 200) => ({ body: b, status }) })
    return { mod, restore, state, c }
  }
  it('refuses a routing code that is not digits, with or without a country', async () => {
    t = setup()
    await expect(t.mod.submitPayoutDetails(t.c({ ...base, routingCode: '=cmd|calc' }))).rejects.toThrow()
    await expect(t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'DE', accountNumber: 'DE89 3704 0044 0532 0130 00', routingCode: '=cmd|calc' }))).rejects.toThrow()
    expect(t.state.patch).toBe(null)
  })
  it('leaves out a routing code that does not belong to the rail (IBAN country) and drops empty optional strings', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'DE', accountNumber: 'DE89 3704 0044 0532 0130 00', routingCode: '123456', swiftBic: '' }))
    expect(t.state.patch.payout_details).toEqual({ bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: 'DE89 3704 0044 0532 0130 00', bankCountry: 'DE' })
  })
  it('an identical resubmission carrying empty optional strings is still a no-op (no hold restart)', async () => {
    const stored = { bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '000123456789', bankCountry: 'US', routingCode: '021000021' }
    t = setup({ payout_method: 'BANK', payout_details: stored })
    const res = await t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'US', routingCode: '021000021', swiftBic: '' }))
    expect(res.body).toMatchObject({ success: true, unchanged: true })
    expect(t.state.updates).toBe(0)
  })
  it('accepts a UK building-society roll number, still refuses a nonsense UK account', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'GB', routingCode: '20-00-00', accountNumber: 'ROLL 1234 567' }))
    expect(t.state.patch.payout_details.accountNumber).toBe('ROLL 1234 567')
    await expect(t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'GB', routingCode: '20-00-00', accountNumber: 'ab' }))).rejects.toThrow()
  })
  it('New Zealand takes its own account number format and needs no SWIFT', async () => {
    t = setup()
    await t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'NZ', accountNumber: '12-3456-7890123-00' }))
    expect(t.state.patch.payout_details).toEqual({ bankName: 'Chase', accountName: 'Alex Morgan', accountNumber: '12-3456-7890123-00', bankCountry: 'NZ' })
    await expect(t.mod.submitPayoutDetails(t.c({ ...base, bankCountry: 'NZ', accountNumber: '12-3456-789' }))).rejects.toThrow()
  })
  it('cleanBankDetails keeps a SWIFT/BIC that was given', () => {
    expect(rails.cleanBankDetails({ ...base, bankCountry: 'SG', swiftBic: 'DBSSSGSG', routingCode: '' })).toEqual({ ...base, bankCountry: 'SG', swiftBic: 'DBSSSGSG' })
  })
})

// Third independent pass: letter-led UK roll numbers, long IBANs, and the rules a later change must not drop.
describe('third pass', () => {
  const base = { payoutMethod: 'BANK', bankName: 'Chase', accountName: 'Alex Morgan' }
  const problems = d => rails.bankRailProblems({ ...base, ...d }).map(p => p.path)
  it('a UK roll number that starts with two letters and two digits is a roll number, not a broken IBAN', () => {
    expect(problems({ bankCountry: 'GB', routingCode: '20-00-00', accountNumber: 'AB12 3456 78' })).toEqual([])
  })
  it('a real UK IBAN, and a mistyped one, are still read as IBANs', () => {
    expect(problems({ bankCountry: 'GB', accountNumber: 'GB82 WEST 1234 5698 7654 32' })).toEqual([])
    expect(problems({ bankCountry: 'GB', accountNumber: 'GB82 WEST 1234 5698 7654 33' })).toEqual(['accountNumber'])
  })
  it('the client form reads them the same way', () => {
    expect(clientRails.bankRail('GB', 'AB12 3456 78')).toBe('routing')
    expect(clientRails.bankRail('GB', 'GB82 WEST 1234 5698 7654 32')).toBe('iban')
    expect(clientRails.bankRail('GB', 'GB00AAAA')).toBe('iban')   // what the form passes when an IBAN is on file
    expect(clientRails.bankRail('NZ')).toBe('local')
  })
  it('a Maltese IBAN is accepted with its spaces (38 characters)', async () => {
    t = setupBank()
    await t.mod.submitPayoutDetails(t.c({ ...base, accountNumber: 'MT84 MALT 0110 0001 2345 MTLC AST0 01S', bankCountry: 'MT' }))
    expect(t.state.patch.payout_details.accountNumber).toBe('MT84 MALT 0110 0001 2345 MTLC AST0 01S')
  })
  it('keeps the round-2 rules in place (a later change must not drop them)', () => {
    expect(typeof rails.cleanBankDetails).toBe('function')
    expect(problems({ bankCountry: 'NZ', accountNumber: '12-3456-7890123-00' })).toEqual([])
    expect(problems({ bankCountry: 'US', routingCode: '=cmd|calc', accountNumber: '000123456789' })).toContain('routingCode')
  })
  function setupBank() {
    const state = { patch: null }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { payout_method: null, payout_details: null }, error: null }
      if (q.table === 'partners' && q.op === 'update') return (state.patch = q.patch, { data: { name: 'Alex', email: 'alex@x.co' }, error: null })
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendPayoutDetailsChanged: async () => true, sendOwnerAlert: async () => true },
    })
    return { mod, restore, state, c: body => ({ env: {}, req: { query: () => 'tok123', json: async () => body }, header: () => {}, json: (b, status = 200) => ({ body: b, status }) }) }
  }
})

// Fourth pass: IBANs are often typed in lowercase.
describe('fourth pass', () => {
  it('a UK IBAN typed in lowercase is still read as an IBAN', () => {
    const p = d => rails.bankRailProblems({ bankName: 'x', accountName: 'y', ...d }).map(x => x.path)
    expect(p({ bankCountry: 'GB', accountNumber: 'gb82 west 1234 5698 7654 32' })).toEqual([])
    expect(p({ bankCountry: 'GB', accountNumber: 'gb82 west 1234 5698 7654 33' })).toEqual(['accountNumber'])
    expect(clientRails.bankRail('GB', 'gb82 west 1234 5698 7654 32')).toBe('iban')
    expect(clientRails.bankProblem({ bankCountry: 'GB', accountNumber: 'gb82 west 1234 5698 7654 32' })).toBe('')
  })
})

// Fifth pass (carried item): the Canadian routing code's ORDER is part of its meaning.
describe('Canadian routing code order', () => {
  const p = d => rails.bankRailProblems({ bankName: 'x', accountName: 'y', accountNumber: '1234567', bankCountry: 'CA', ...d }).map(x => x.path)
  it('takes transit-dash-institution only; bare digits and the reverse order are refused', () => {
    expect(p({ routingCode: '12345-678' })).toEqual([])
    expect(p({ routingCode: '12345 - 678' })).toEqual([])
    expect(p({ routingCode: '12345678' })).toEqual(['routingCode'])
    expect(p({ routingCode: '003-12345' })).toEqual(['routingCode'])
  })
  it('the form checks it the same way', () => {
    expect(clientRails.bankProblem({ bankCountry: 'CA', routingCode: '12345-678', accountNumber: '1234567' })).toBe('')
    expect(clientRails.bankProblem({ bankCountry: 'CA', routingCode: '12345678', accountNumber: '1234567' })).toMatch(/transit number, a dash/)
    expect(clientRails.bankProblem({ bankCountry: 'CA', routingCode: '003-12345', accountNumber: '1234567' })).toMatch(/transit number, a dash/)
  })
})
