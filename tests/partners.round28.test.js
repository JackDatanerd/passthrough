import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 28: moving a sale between partners - self-referral guard, usage-limit refusal, and both partners told.

let t
afterEach(() => t?.restore())
const PID = '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11'
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD' },
  get: k => (k === 'user' ? { id: 'admin-1', email: 'a@x.co' } : undefined),
  req: { param: k => (over.params || {})[k ?? 'id'] ?? PID, query: () => undefined, json: async () => over.body ?? {}, header: () => undefined },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})

describe('re-attributing a sale, round 28', () => {
  const sale = { id: 'led1', partner_id: PID, referral_code_id: 'rcOld', kind: 'SALE', reverses_ledger_id: null, payment_id: 'pay1', gross_amount_cents: 2900, commission_amount_cents: 580, payout_id: null }
  const target = { id: 'rcNew', partner_id: 'p2', code: 'NEW10', active: true, partners: { status: 'ACTIVE', email: 'n@x.co', previous_emails: ['older@x.co'], commission_rate: 0.3 } }
  const body = { toCode: 'new10', reason: 'buyer used the wrong code, see ticket 41' }
  function setup({ buyerEmail = 'buyer@x.co', userId = 'u1', outcome = 'ok', mailOk = true } = {}) {
    const rpcs = [], sent = []
    const db = createFakeSupabase(q => {
      if (q.op === 'rpc') { rpcs.push(q); return { data: outcome, error: null } }
      if (q.table === 'commission_ledger') return { data: sale, error: null }
      if (q.table === 'referral_codes') return { data: target, error: null }
      if (q.table === 'payments') return { data: { user_id: userId, currency: 'KES' }, error: null }
      if (q.table === 'users') return { data: buyerEmail ? { email: buyerEmail } : null, error: null }
      if (q.table === 'partners') return { data: [{ id: PID, name: 'Old P', email: 'old@x.co' }, { id: 'p2', name: 'New P', email: 'n@x.co' }], error: null }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerAlert: async () => {},
        sendPartnerSaleMoved: async (...a) => { sent.push(a); if (!mailOk) throw new Error('smtp down'); return true },
      },
    })
    return { mod: t.mod, rpcs, sent }
  }
  const run = (s, params = { id: PID, ledgerId: 'led1' }) => s.mod.adminReattributeSale(ctxOf({ body, params }))

  it('refuses a buyer who is the target partner, or used one of their earlier addresses, and never reaches the database move', async () => {
    for (const email of ['N@x.co', 'older@x.co']) {
      const s = setup({ buyerEmail: email })
      const res = await run(s)
      expect(res).toMatchObject({ status: 409, body: { success: false, code: 'SELF_REFERRAL' } })
      expect(s.rpcs).toHaveLength(0)
      expect(s.sent).toHaveLength(0)
    }
  })
  it('does not block a buyer it cannot resolve (no account, no email)', async () => {
    expect((await run(setup({ userId: null }))).body.success).toBe(true)
    expect((await run(setup({ buyerEmail: null }))).body.success).toBe(true)
  })
  it('reports a target at its usage limit as a 409, not a generic failure', async () => {
    const res = await run(setup({ outcome: 'target_exhausted' }))
    expect(res).toMatchObject({ status: 409, body: { success: false, code: 'TARGET_EXHAUSTED' } })
  })
  it('tells the old partner what they lost and the new partner what they gained, without the admin reason', async () => {
    const s = setup()
    const res = await run(s)
    expect(res.body).toMatchObject({ success: true, emailed: { from: true, to: true } })
    expect(s.sent).toHaveLength(2)
    const away = s.sent.find(a => a[2] === 'old@x.co'), to = s.sent.find(a => a[2] === 'n@x.co')
    expect(away.slice(3)).toEqual(['Old P', 'away', 580, 'KES'])
    expect(to.slice(3)).toEqual(['New P', 'to', 870, 'KES'])
    expect(JSON.stringify(s.sent.map(a => a.slice(2)))).not.toMatch(/ticket 41|wrong code/)
  })
  it('a mail failure is reported but never undoes the committed move', async () => {
    const res = await run(setup({ mailOk: false }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, emailed: { from: false, to: false } })
  })
  it('sends nothing when the database refused the move', async () => {
    const s = setup({ outcome: 'already_paid' })
    expect((await run(s)).status).toBe(409)
    expect(s.sent).toHaveLength(0)
  })
})
