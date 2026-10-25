import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Partners round 39: the terms-acceptance log is erased / purged with its owner, a code request is a stored row (not an alert email only),
// the partial-refund give-back survives a failed first attempt, and the admin list of code requests.

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', JWT_SECRET: 'test-link-secret-0123456789abcdef0123', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: kv(), ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }), executionCtx: { waitUntil: () => {} },
})
const PARTNER = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK', payout_details: null,
  payout_details_submitted_at: null, terms_version: null, previous_emails: ['old@x.co'],
  dashboard_token: 'dtok', dashboard_token_version: 0, commission_rate: 0.1, notify_conversions: true,
}

function setup(o = {}) {
  const st = { alerts: [], requests: o.requests || [], reqInserts: [], reqUpdates: [], calls: [] }
  const db = createFakeSupabase(q => {
    st.calls.push(q)
    if (q.table === 'partners' && q.op === 'select') {
      const eq = q.filters.find(f => f[0] === 'eq' && /token/.test(f[1]))
      if (eq) return { data: eq[1] === 'dashboard_token' && eq[2] === 'dtok' ? PARTNER : null, error: null }
      return { data: PARTNER, error: null }
    }
    if (q.table === 'partner_code_requests' && q.op === 'select' && q.selectOpts && q.selectOpts.count)
      return { data: st.requests, count: st.requests.length, error: null }
    if (q.table === 'partner_code_requests' && q.op === 'select') return { data: st.requests.find(r => r.status === 'OPEN') ?? null, error: null }
    if (q.table === 'partner_code_requests' && q.op === 'insert') {
      if (o.insertError) return { data: null, error: o.insertError }
      st.reqInserts.push(q.values); return { data: null, error: null }
    }
    if (q.table === 'partner_code_requests' && q.op === 'update') { st.reqUpdates.push({ patch: q.patch, filters: q.filters }); return { data: o.resolved === undefined ? { id: 'r1', partner_id: 'p1' } : o.resolved, error: null } }
    if (q.table === 'referral_codes' && q.op === 'select') return { data: null, error: null }
    return undefined
  })
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (...a) => { st.alerts.push(a); return o.alertOk === undefined ? true : o.alertOk } },
  })
  return { ...m, st, db }
}
const req = (body = { code: 'mynews' }) => ctxOf({ headers: { 'x-partner-token': 'dtok' }, body })

describe('requestPartnerCode is stored, not only mailed', () => {
  it('keeps the request when the owner alert could not be sent', async () => {
    t = setup({ alertOk: false })
    const res = await t.mod.requestPartnerCode(req())
    expect(res.body.success).toBe(true)
    expect(t.st.reqInserts).toEqual([{ partner_id: 'p1', wanted_code: 'MYNEWS', note: null }])
  })
  it('a stale open request (over a week) is bumped and the owner nudged again; a fresh one is not', async () => {
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
    t = setup({ requests: [{ id: 'r1', status: 'OPEN', created_at: old }] })
    const res = await t.mod.requestPartnerCode(req())
    expect(res.body.alreadyRequested).toBeUndefined()
    expect(t.st.reqUpdates[0].patch).toMatchObject({ wanted_code: 'MYNEWS' })
    expect(t.st.alerts).toHaveLength(1)
    t.restore()
    t = setup({ requests: [{ id: 'r1', status: 'OPEN', created_at: new Date().toISOString() }] })
    const again = await t.mod.requestPartnerCode(req())
    expect(again.body.alreadyRequested).toBe(true)
    expect(t.st.alerts).toHaveLength(0)
    expect(t.st.reqUpdates).toHaveLength(0)
  })
  it('a lost race on the one-open-request index reads as already requested', async () => {
    t = setup({ insertError: { code: '23505', message: 'dup' } })
    const res = await t.mod.requestPartnerCode(req())
    expect(res.body).toMatchObject({ success: true, alreadyRequested: true })
    expect(t.st.alerts).toHaveLength(0)
  })
})

describe('admin code requests', () => {
  it('lists them with the partner name and resolves one', async () => {
    t = setup({ requests: [{ id: 'r1', partner_id: 'p1', wanted_code: 'X', note: 'n', status: 'OPEN', created_at: 'now', resolved_at: null, partners: { name: 'Coach K', email: 'k@x.co' } }] })
    const list = await t.mod.adminListCodeRequests(ctxOf())
    expect(list.body.total).toBe(1)
    expect(list.body.data[0]).toMatchObject({ id: 'r1', partnerName: 'Coach K', wantedCode: 'X', status: 'OPEN' })
    const done = await t.mod.adminResolveCodeRequest(ctxOf({ params: { id: 'r1' }, body: { status: 'DONE' } }))
    expect(done.body.success).toBe(true)
    expect(t.st.reqUpdates[0].patch.status).toBe('DONE')
    expect(t.st.reqUpdates[0].filters).toContainEqual(['eq', 'status', 'OPEN'])
  })
  it('refuses an unknown or already answered request, and a bad status', async () => {
    t = setup({ resolved: null })
    const gone = await t.mod.adminResolveCodeRequest(ctxOf({ params: { id: 'r1' }, body: { status: 'DISMISSED' } }))
    expect(gone.status).toBe(404)
    await expect(t.mod.adminResolveCodeRequest(ctxOf({ params: { id: 'r1' }, body: { status: 'OPEN' } }))).rejects.toThrow()
  })
})

describe('erasure also clears the terms-acceptance log', () => {
  it('nulls the identifying columns on the partner rows and deletes the email-only rows for every address', async () => {
    t = setup()
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(res.body.success).toBe(true)
    const upd = t.st.calls.find(q => q.table === 'partner_terms_acceptances' && q.op === 'update')
    expect(upd.patch).toEqual({ application_email: null, ip_hash: null, user_agent: null })
    expect(upd.filters).toContainEqual(['eq', 'partner_id', 'p1'])
    const dels = t.st.calls.filter(q => q.table === 'partner_terms_acceptances' && q.op === 'delete')
    expect(dels.map(q => q.filters.find(f => f[0] === 'ilike')[2]).sort()).toEqual(['k@x.co', 'old@x.co'])
    // before the partner row is wiped, so a retry still knows the addresses
    const order = t.st.calls.map(q => `${q.table}:${q.op}`)
    expect(order.indexOf('partner_terms_acceptances:update')).toBeLessThan(order.lastIndexOf('partners:update'))
  })
})

describe('reverseCommission give-back survives a failed first attempt', () => {
  const run = async ({ partials, revInsErr, giveBackErr }) => {
    const inserts = []
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'payment_id'))
        return { data: { id: 'orig', partner_id: 'p1', referral_code_id: null, gross_amount_cents: 5000, commission_rate: 0.2, commission_amount_cents: 1000, currency: 'USD', payout_id: null }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select' && q.filters.some(f => f[1] === 'adjusts_ledger_id')) return { data: partials, error: null }
      if (q.table === 'commission_ledger' && q.op === 'insert') {
        inserts.push(q.values)
        if (q.values.kind === 'ADJUSTMENT') return { data: null, error: giveBackErr || null }
        return { data: null, error: revInsErr || null }
      }
      return undefined
    })
    const out = await require('../src/services/fulfillment.service').reverseCommission(db, 'pay1', 'REFUND')
    return { out, inserts }
  }
  it('a redelivered refund (reversal already in) still hands the partials back', async () => {
    const { out, inserts } = await run({ partials: [{ commission_amount_cents: -400 }], revInsErr: { code: '23505', message: 'dup' } })
    expect(out).toEqual({ reversed: false, reason: 'already-reversed' })
    expect(inserts.filter(i => i.kind === 'ADJUSTMENT')).toHaveLength(1)
    expect(inserts.find(i => i.kind === 'ADJUSTMENT')).toMatchObject({ commission_amount_cents: 400, adjusts_ledger_id: 'orig' })
  })
  it('does nothing once the partials net to zero (already handed back)', async () => {
    const { inserts } = await run({ partials: [{ commission_amount_cents: -400 }, { commission_amount_cents: 400 }], revInsErr: { code: '23505' } })
    expect(inserts.filter(i => i.kind === 'ADJUSTMENT')).toHaveLength(0)
  })
  it('a second give-back refused by the unique index is not an error', async () => {
    const { out } = await run({ partials: [{ commission_amount_cents: -400 }], giveBackErr: { code: '23505', message: 'dup' } })
    expect(out.reversed).toBe(true)
  })
})

describe('retention sweep', () => {
  it('purges orphaned terms-acceptance rows through the database function', async () => {
    const calls = []
    const db = createFakeSupabase(q => { if (q.op === 'rpc') { calls.push(q.name); return { data: 3, error: null } } return undefined })
    const out = await require('../src/services/retention.service').purgeUnlinkedTermsAcceptances(db)
    expect(calls[0]).toBe('purge_unlinked_terms_acceptances')
    expect(out.deleted).toBeGreaterThanOrEqual(3)
  })
})
