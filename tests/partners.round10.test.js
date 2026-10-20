import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 10: attribution on the account, price guardrails, owed netting per partner, chunked ids, date-only `to`,
// self-serve link reset, terms confirmation, step-up coverage, notices.

let t
afterEach(() => t?.restore())
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', PAYSTACK_CURRENCY: 'USD', ...(over.env || {}) },
  get: k => (k === 'user' ? (over.user || { id: 'admin-1', email: 'a@x.co' }) : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
  executionCtx: { waitUntil: () => {} },
})

const PARTNER = { id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', dashboard_token: 'dtok', payout_token_hash: require('node:crypto').createHash('sha256').update('ptok').digest('hex'), commission_rate: 0.1 }

function load(handler, emailStubs = {}) {
  const db = createFakeSupabase(handler)
  t = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async () => {}, sendReferralCodeCreated: async () => true, ...emailStubs },
  })
  return t.mod
}

let expiringOk = true
const opts_expiringOk = () => expiringOk
describe('price guardrails on referral codes', () => {
  const run = async (body, env) => {
    const inserts = []
    const mod = load(q => {
      if (q.table === 'partners') return { data: PARTNER, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') { inserts.push(q.values); return { data: { id: 'c1', ...q.values }, error: null } }
      return undefined
    })
    const res = await mod.adminCreateReferralCode(ctxOf({ body, env }))
    return { res, inserts }
  }
  it('refuses a price far below standard (49 cents typed for $49) until confirmed', async () => {
    const { res, inserts } = await run({ code: 'TYPO', tierPrices: { FIX: 49 } })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('PRICE_TOO_LOW')
    expect(res.body.details[0]).toMatchObject({ tier: 'FIX', price: 49, standard: 4900 })
    expect(inserts).toHaveLength(0)
  })
  it('accepts it with confirmLowPrice', async () => {
    const { res, inserts } = await run({ code: 'TYPO', tierPrices: { FIX: 49 }, confirmLowPrice: true })
    expect(res.status).toBe(200)
    expect(inserts).toHaveLength(1)
  })
  it('a normal discount passes, and a price not below standard comes back as a warning', async () => {
    const ok = await run({ code: 'FINE', tierPrices: { FIX: 3900 } })
    expect(ok.res.status).toBe(200); expect(ok.res.body.warnings).toEqual([])
    const flat = await run({ code: 'FLAT', tierPrices: { FIX: 4900 } })
    expect(flat.res.status).toBe(200); expect(flat.res.body.warnings[0]).toMatch(/no discount/)
  })
  it('the floor is configurable (REFERRAL_MIN_PRICE_PCT=0 turns it off)', async () => {
    const { res } = await run({ code: 'TINY', tierPrices: { FIX: 49 } }, { REFERRAL_MIN_PRICE_PCT: '0' })
    expect(res.status).toBe(200)
  })
})

describe('admin payouts log — a date-only `to` covers the whole day', () => {
  it('turns 2026-09-30 into the end of that day (UTC)', async () => {
    let filters
    const mod = load(q => { if (q.table === 'payouts') { filters = q.filters; return { data: [], count: 0, error: null } } })
    await mod.adminListPayouts(ctxOf({ query: { to: '2026-09-30', from: '2026-09-01' } }))
    const lte = filters.find(f => f[0] === 'lte' && f[1] === 'paid_at')
    expect(lte[2]).toBe('2026-09-30T23:59:59.999Z')
  })
  it('a full timestamp is left exactly as given', async () => {
    let filters
    const mod = load(q => { if (q.table === 'payouts') { filters = q.filters; return { data: [], count: 0, error: null } } })
    await mod.adminListPayouts(ctxOf({ query: { to: '2026-09-30T10:00:00Z' } }))
    expect(filters.find(f => f[0] === 'lte')[2]).toBe('2026-09-30T10:00:00.000Z')
  })
})

describe('overview — refund credit never nets across partners', () => {
  it('owed sums each partner at max(0, net) and reports credit separately', async () => {
    const mod = load(q => {
      if (q.table === 'partners') return { data: null, count: 3, error: null }
      if (q.table === 'partner_applications') return { data: null, count: 0, error: null }
      if (q.table === 'payouts') return { data: [{ id: 'a', amount_cents: 500 }], error: null }
      if (q.table === 'commission_ledger') {
        const unpaid = q.filters.some(f => f[0] === 'is' && f[1] === 'payout_id')
        return { data: unpaid
          ? [{ id: '1', partner_id: 'A', commission_amount_cents: 1000 }, { id: '2', partner_id: 'B', commission_amount_cents: -300 }, { id: '3', partner_id: 'B', commission_amount_cents: 100 }, { id: '4', partner_id: 'C', commission_amount_cents: 200 }]
          : [{ id: '1', commission_amount_cents: 2000 }], error: null }
      }
      return undefined
    })
    const res = await mod.adminPartnersOverview(ctxOf())
    expect(res.body.data.owedCents).toBe(1200)    // A 1000 + C 200; B is -200 (credit), not netted against them
    expect(res.body.data.creditCents).toBe(200)
  })
})

describe('partner conversions — payout id and filters', () => {
  const rows = [{ id: 'l1', referral_code_id: 'c1', gross_amount_cents: 1000, commission_rate: 0.1, commission_amount_cents: 100, payout_id: 'po1', created_at: '2026-09-01T00:00:00Z', kind: 'SALE' }]
  const run = async query => {
    let ledgerFilters
    const mod = load(q => {
      if (q.table === 'partners') return { data: PARTNER, error: null }
      if (q.table === 'referral_codes') return { data: [{ id: 'c1', code: 'K' }], error: null }
      if (q.table === 'commission_ledger') { ledgerFilters = q.filters; return { data: rows, count: 1, error: null } }
      return undefined
    })
    const res = await mod.getPartnerConversions(ctxOf({ query: { ...query }, headers: { 'x-partner-token': 'dtok' } }))
    return { res, ledgerFilters }
  }
  it('rows carry the payout that settled them', async () => {
    const { res } = await run({})
    expect(res.body.data[0].payoutId).toBe('po1')
  })
  it('payoutId narrows to that payout; a malformed id matches nothing', async () => {
    const good = await run({ payoutId: '0b0c8c64-1d0f-4f7e-9a49-0a6a4b1f4c11' })
    expect(good.ledgerFilters.some(f => f[0] === 'eq' && f[1] === 'payout_id')).toBe(true)
    const bad = await run({ payoutId: 'nope' })
    expect(bad.ledgerFilters.some(f => f[0] === 'eq' && f[1] === 'id' && /^0{8}/.test(f[2]))).toBe(true)
  })
})

describe('partner self-serve link reset', () => {
  const setup = (emailOk) => {
    const updates = []
    const mod = load(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: q.filters.some(f => f[1] === 'dashboard_token' && f[2] === 'dtok') ? PARTNER : null, error: null }
      if (q.table === 'partners' && q.op === 'update') { updates.push(q); return { data: { id: 'p1' }, error: null } }
      return undefined
    }, { sendPartnerLinksSelfReset: async () => emailOk })
    return { mod, updates }
  }
  it('rotates BOTH tokens, emails the address on file, and never returns a link', async () => {
    const { mod, updates } = setup(true)
    const res = await mod.resetMyPartnerLinks(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toMatch(/token=/)
    expect(updates).toHaveLength(1)
    expect(updates[0].patch.dashboard_token).toBeTruthy()
    expect(updates[0].patch.payout_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(updates[0].patch.payout_details_token).toBeNull()
    expect(updates[0].filters.some(f => f[0] === 'eq' && f[1] === 'dashboard_token' && f[2] === 'dtok')).toBe(true)   // guarded on the presented token
  })
  it('undoes the swap when the email cannot be sent (nobody is locked out)', async () => {
    const { mod, updates } = setup(false)
    const res = await mod.resetMyPartnerLinks(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.status).toBe(502)
    expect(updates).toHaveLength(2)
    expect(updates[1].patch).toEqual({ dashboard_token: 'dtok', payout_token_hash: require('node:crypto').createHash('sha256').update('ptok').digest('hex') })
  })
  it('an unknown token is a plain 404', async () => {
    const { mod } = setup(true)
    const res = await mod.resetMyPartnerLinks(ctxOf({ headers: { 'x-partner-token': 'zzz' } }))
    expect(res.status).toBe(404)
  })
})

describe('referral attribution kept on the account', () => {
  const setup = (codeRow) => {
    const updates = []
    t = loadWithStubs('services/referral.service.js', {})
    const db = createFakeSupabase(q => {
      if (q.table === 'referral_codes') return { data: codeRow, error: null }
      if (q.table === 'users' && q.op === 'update') { updates.push(q.patch); return { data: null, error: null } }
      return undefined
    })
    return { svc: t.mod, db, updates }
  }
  const GOOD = { id: 'c', code: 'K20', active: true, expires_at: null, usage_limit: null, uses_so_far: 0, tier_prices: { FIX: 3900 }, partners: { status: 'ACTIVE', email: 'k@x.co' } }
  it('stores a usable code with a timestamp', async () => {
    const { svc, db, updates } = setup(GOOD)
    const out = await svc.setUserAttribution(db, { id: 'u1', email: 'buyer@x.co' }, ' k20 ')
    expect(out).toMatchObject({ stored: true, code: 'K20' })
    expect(updates[0].referred_by_code).toBe('K20'); expect(updates[0].referred_at).toBeTruthy()
  })
  it('does not store an unknown/inactive code, a malformed one, or the partner\'s own address', async () => {
    const a = setup({ ...GOOD, active: false })
    expect((await a.svc.setUserAttribution(a.db, { id: 'u1', email: 'b@x.co' }, 'K20')).stored).toBe(false)
    expect(a.updates).toHaveLength(0)
    const b = setup(GOOD)
    expect((await b.svc.setUserAttribution(b.db, { id: 'u1', email: 'b@x.co' }, 'bad code!')).reason).toBe('format')
    const c = setup(GOOD)
    expect((await c.svc.setUserAttribution(c.db, { id: 'u1', email: 'K@X.co' }, 'K20')).reason).toBe('self')
  })
  it('null or blank clears it (the buyer removed the code on purpose)', async () => {
    const { svc, db, updates } = setup(GOOD)
    expect(await svc.setUserAttribution(db, { id: 'u1', email: 'b@x.co' }, '')).toEqual({ cleared: true })
    expect(updates[0]).toEqual({ referred_by_code: null, referred_at: null, referred_sub: null })
  })
  // Round 17: the channel tag (&sub=) is kept on the account with the code, last click wins.
  it('stores a valid channel tag with the code, normalised, and drops an invalid one', async () => {
    const a = setup(GOOD)
    const out = await a.svc.setUserAttribution(a.db, { id: 'u1', email: 'b@x.co' }, 'K20', undefined, ' YouTube-Jan ')
    expect(out).toMatchObject({ stored: true, code: 'K20', referredSub: 'youtube-jan' })
    expect(a.updates[0].referred_sub).toBe('youtube-jan')
    const b = setup(GOOD)
    await b.svc.setUserAttribution(b.db, { id: 'u1', email: 'b@x.co' }, 'K20', undefined, 'bad tag!')
    expect(b.updates[0].referred_sub).toBeNull()
  })
  it('a click without a tag replaces an older tag instead of keeping it', async () => {
    const a = setup(GOOD)
    await a.svc.setUserAttribution(a.db, { id: 'u1', email: 'b@x.co' }, 'K20')
    expect(a.updates[0]).toHaveProperty('referred_sub', null)
  })
})

describe('wiring', () => {
  const routes = read('src/routes/partners.routes.js')
  it('credential- and price-setting admin routes need the step-up', () => {
    expect(routes).toMatch(/post\(\s*'\/',\s+admin, admin\.stepUp,/)
    expect(routes).toMatch(/applications\/:id\/approve',\s+admin, admin\.stepUp/)
    expect(routes).toMatch(/stepUpWhen\(body => !!body && \(body\.tierPrices !== undefined \|\| body\.code !== undefined\)\)/)
    expect(routes).toMatch(/'\/payout-export',\s+admin, admin\.stepUp/)
  })
  it('self-serve reset and attribution have their own limiter buckets', () => {
    expect(routes).toMatch(/'\/reset-links', rl\.partnerReset/)
    expect(routes).toMatch(/'\/attribution', auth, rl\.referralAttribution/)
    expect(routes).toMatch(/rl\.partnerExport/)
  })
  it('migration 0079 adds the columns and ends with its own version', () => {
    const sql = read('supabase/migrations/0079_partners_section4_round10.sql')
    for (const col of ['referred_by_code', 'referred_at', 'referral_source', 'attribution_source']) expect(sql).toMatch(new RegExp(`add column if not exists ${col}`))
    expect(sql.trimEnd().split('\n').slice(-3).join('\n')).toMatch(/'version', 79/)
  })
  it('the payout core chunks every id list it sends to PostgREST', () => {
    const src = read('src/controllers/partners.controller.js')
    expect(src).not.toMatch(/^\s*\.in\('id', ledgerIds\)/m)
    expect(src).not.toMatch(/\.in\('reverses_ledger_id', originalIds\)\s*$/m)
    expect((src.match(/selectInChunks\(/g) || []).length).toBeGreaterThanOrEqual(2)   // definition + the remaining call sites (the claim itself is one RPC now)
  })
})

describe('referral notices', () => {
  const setup = (rows, kv = new Map()) => {
    const sent = []
    t = loadWithStubs('services/referral.service.js', {
      'services/email.service.js': {
        sendOwnerAlert: async (...a) => { sent.push(['owner', a[1]]) },
        sendPartnerCodeLimitReached: async (...a) => { sent.push(['limit', a[4]]); return true },
        sendPartnerCodeExpiring: async (...a) => { sent.push(['expiring', a[4]]); return opts_expiringOk() },
      },
    })
    const db = createFakeSupabase(q => {
      if (q.table === 'commission_ledger') return { data: null, count: rows.recent ?? 0, error: null }
      if (q.table === 'referral_codes' && q.op === 'select' && q.filters.some(f => f[0] === 'gt')) return { data: rows.expiring ?? [], error: null }
      if (q.table === 'referral_codes') return { data: rows.code ?? null, error: null }
      return undefined
    })
    const env = { RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } }, ...(rows.env || {}) }
    return { svc: t.mod, db, env, sent }
  }
  const CODE = { id: 'c1', code: 'K20' }
  const PARTNER_ROW = { name: 'K', email: 'k@x.co' }

  it('alerts the owner once per day when one code converts at/over the hourly threshold', async () => {
    const kv = new Map()
    const a = setup({ recent: 12, code: { code: 'K20', usage_limit: null, uses_so_far: 12 } }, kv)
    await a.svc.afterConversionNotices(a.db, a.env, CODE, PARTNER_ROW)
    await a.svc.afterConversionNotices(a.db, a.env, CODE, PARTNER_ROW)
    expect(a.sent.filter(s => s[0] === 'owner')).toHaveLength(1)
  })
  it('stays quiet below the threshold, and REFERRAL_VELOCITY_ALERT=0 turns it off', async () => {
    const quiet = setup({ recent: 3, code: { code: 'K20', usage_limit: null, uses_so_far: 3 } })
    await quiet.svc.afterConversionNotices(quiet.db, quiet.env, CODE, PARTNER_ROW)
    expect(quiet.sent).toHaveLength(0)
    const off = setup({ recent: 500, env: { REFERRAL_VELOCITY_ALERT: '0' }, code: { code: 'K20', usage_limit: null, uses_so_far: 500 } })
    await off.svc.afterConversionNotices(off.db, off.env, CODE, PARTNER_ROW)
    expect(off.sent).toHaveLength(0)
  })
  it('tells the partner once when a limited code reaches its limit', async () => {
    const kv = new Map()
    const a = setup({ recent: 1, code: { code: 'K20', usage_limit: 5, uses_so_far: 5 } }, kv)
    await a.svc.afterConversionNotices(a.db, a.env, CODE, PARTNER_ROW)
    await a.svc.afterConversionNotices(a.db, a.env, CODE, PARTNER_ROW)
    expect(a.sent.filter(s => s[0] === 'limit')).toEqual([['limit', 'K20']])
  })
  it('the sweep warns each active partner once per expiry date, and re-arms when the date is extended', async () => {
    const kv = new Map()
    const row = (date) => ({ id: 'c1', code: 'K20', expires_at: date, partners: { name: 'K', email: 'k@x.co', status: 'ACTIVE' } })
    const a = setup({ expiring: [row('2026-10-15T00:00:00Z')] }, kv)
    await a.svc.sweepExpiringCodes(a.db, a.env); await a.svc.sweepExpiringCodes(a.db, a.env)
    expect(a.sent.filter(s => s[0] === 'expiring')).toHaveLength(1)
    const b = setup({ expiring: [row('2026-10-17T00:00:00Z')] }, kv)
    await b.svc.sweepExpiringCodes(b.db, b.env)
    expect(b.sent.filter(s => s[0] === 'expiring')).toHaveLength(1)
  })
  it('round 11: a failed send is not marked as sent (retried next sweep) and is reported as failed', async () => {
    const kv = new Map()
    const row = { id: 'c1', code: 'K20', expires_at: '2026-10-15T00:00:00Z', partners: { name: 'K', email: 'k@x.co', status: 'ACTIVE' } }
    expiringOk = false
    const a = setup({ expiring: [row] }, kv)
    const r1 = await a.svc.sweepExpiringCodes(a.db, a.env)
    expect(r1).toMatchObject({ notified: 0, failed: 1 })
    expiringOk = true
    const r2 = await a.svc.sweepExpiringCodes(a.db, a.env)
    expect(r2).toMatchObject({ notified: 1, failed: 0 })
    expect(a.sent.filter(s => s[0] === 'expiring')).toHaveLength(2)
  })
  it('a paused partner is not told', async () => {
    const a = setup({ expiring: [{ id: 'c9', code: 'P1', expires_at: '2026-10-15T00:00:00Z', partners: { name: 'K', email: 'k@x.co', status: 'PAUSED' } }] })
    expect((await a.svc.sweepExpiringCodes(a.db, a.env)).notified).toBe(0)
  })
})
