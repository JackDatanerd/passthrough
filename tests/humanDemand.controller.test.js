import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createFakeSupabase } = require_('./helpers/fakeSupabase.cjs')

const VID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
let t
function setup(resolver = () => undefined) {
  const db = createFakeSupabase(resolver)
  const { mod, restore } = loadWithStubs('controllers/human-demand.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  t = { mod, restore, db }
  return t
}
afterEach(() => { t?.restore(); t = null; vi.restoreAllMocks() })

const ctx = ({ body, query = {}, user, authError, rawJson } = {}) => ({
  env: {},
  req: { query: k => query[k], json: async () => { if (rawJson) throw new SyntaxError('bad'); return body } },
  get: k => (k === 'user' ? user : k === 'authError' ? authError : undefined),
  json: (b, status = 200) => ({ body: b, status }),
})

describe('price variants (pure)', () => {
  const hd = require_('../src/lib/humanDemand.js')
  it('the three variants are built from product spec 16.1: base = suggested start, low/high = ends of the test range', () => {
    expect(hd.PRICE_VARIANTS.base).toEqual({ polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 })
    expect(hd.PRICE_VARIANTS.low).toEqual({ polish: 4900, seven_day: 7900, forty_eight_hour: 9900, twenty_four_hour: 12900, cover_letter: 2500 })
    expect(hd.PRICE_VARIANTS.high).toEqual({ polish: 6900, seven_day: 9900, forty_eight_hour: 13900, twenty_four_hour: 17900, cover_letter: 3900 })
  })
  it('a visitor id always maps to the same variant, and a spread of ids reaches all three', async () => {
    expect(await hd.variantForVisitor(VID)).toBe(await hd.variantForVisitor(VID))
    const seen = new Set()
    for (let i = 0; i < 60; i++) seen.add(await hd.variantForVisitor(i.toString(16).padStart(32, '0')))
    expect([...seen].sort()).toEqual(['base', 'high', 'low'])
  })
  it('the flag is on only for the exact string "true"', () => {
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true']) expect(hd.humanDemandEnabled({ HUMAN_DEMAND_ENABLED: v })).toBe(false)
    expect(hd.humanDemandEnabled({ HUMAN_DEMAND_ENABLED: 'true' })).toBe(true)
    expect(hd.humanDemandEnabled(undefined)).toBe(false)
  })
})

describe('GET config', () => {
  it('returns the visitor\'s variant and its price table, stable across calls', async () => {
    setup()
    const a = await t.mod.getConfig(ctx({ query: { vid: VID } }))
    const b = await t.mod.getConfig(ctx({ query: { vid: VID } }))
    expect(a.status).toBe(200)
    expect(a.body.data).toEqual(b.body.data)
    expect(a.body.data.prices).toEqual(require_('../src/lib/humanDemand.js').PRICE_VARIANTS[a.body.data.variant])
    expect(a.body.data.currency).toBe('USD')
  })
  it('rejects a missing or malformed visitor id', async () => {
    setup()
    for (const vid of [undefined, '', 'short', 'Z'.repeat(32), VID.toUpperCase()]) expect((await t.mod.getConfig(ctx({ query: { vid } }))).status).toBe(400)
  })
})

describe('POST events', () => {
  it('stores one row with the server-derived variant, the tier and the cover letter flag, and nothing else', async () => {
    setup()
    const res = await t.mod.postEvent(ctx({ body: { event: 'tier_selected', visitorId: VID, tier: 'seven_day' } }))
    expect(res.status).toBe(200)
    const q = t.db.calls.find(c => c.op === 'insert')
    expect(q.table).toBe('human_demand_events')
    expect(Object.keys(q.values).sort()).toEqual(['cover_letter', 'event', 'price_variant', 'tier', 'visitor_id'])
    expect(q.values).toMatchObject({ event: 'tier_selected', tier: 'seven_day', visitor_id: VID, cover_letter: null })
    expect(q.values.price_variant).toBe(await require_('../src/lib/humanDemand.js').variantForVisitor(VID))
  })
  it('accepts every client-sendable event', async () => {
    setup()
    for (const body of [
      { event: 'button_shown', visitorId: VID }, { event: 'button_clicked', visitorId: VID }, { event: 'modal_dismissed', visitorId: VID, tier: 'polish' },
      { event: 'tier_selected', visitorId: VID, tier: 'polish' }, { event: 'cover_letter_toggled', visitorId: VID, coverLetter: true, tier: 'polish' },
    ]) expect((await t.mod.postEvent(ctx({ body }))).status, JSON.stringify(body)).toBe(200)
  })
  it('refuses free text, unknown keys, a client-chosen variant or price, and a client claiming a submitted waitlist', async () => {
    setup()
    const bads = [
      { event: 'button_shown', visitorId: VID, resumeText: 'Jane Doe, jane@example.com' },
      { event: 'button_shown', visitorId: VID, email: 'jane@example.com' },
      { event: 'button_shown', visitorId: VID, priceVariant: 'low' },
      { event: 'button_shown', visitorId: VID, price: 1 },
      { event: 'waitlist_submitted', visitorId: VID, tier: 'polish' },
      { event: 'tier_selected', visitorId: VID },                       // a choice event must name the choice
      { event: 'cover_letter_toggled', visitorId: VID },
      { event: 'tier_selected', visitorId: VID, tier: 'gold' },
      { event: 'nope', visitorId: VID }, { event: 'button_shown' }, { event: 'button_shown', visitorId: 'x' }, null, 'str',
    ]
    for (const body of bads) expect((await t.mod.postEvent(ctx({ body }))).status, JSON.stringify(body)).toBe(400)
    expect((await t.mod.postEvent(ctx({ rawJson: true }))).status).toBe(400)
    expect(t.db.calls.filter(c => c.op === 'insert')).toHaveLength(0)
  })
})

describe('POST waitlist', () => {
  const joined = (over = {}) => (q) => (q.op === 'upsert' ? { data: [{ id: 'w1' }], error: null } : undefined)
  const USER = { id: '00000000-0000-4000-8000-000000000001' }

  it('signed in: keyed on the account, the account email is NOT copied, quote taken from the server table', async () => {
    setup(joined())
    const res = await t.mod.postWaitlist(ctx({ user: USER, body: { visitorId: VID, tier: 'forty_eight_hour', coverLetter: true, consent: true } }))
    expect(res).toEqual({ status: 200, body: { success: true, data: { joined: true, alreadyOnList: false } } })
    const up = t.db.calls.find(c => c.op === 'upsert')
    expect(up.table).toBe('human_demand_waitlist')
    expect(up.onConflict).toBe('identity_key,tier')
    expect(up.ignoreDuplicates).toBe(true)
    expect(up.values).toMatchObject({ identity_key: `u:${USER.id}`, user_id: USER.id, email: null, tier: 'forty_eight_hour', cover_letter_interest: true, contact_consent: true, visitor_id: VID })
    const variant = await require_('../src/lib/humanDemand.js').variantForVisitor(VID)
    expect(up.values.price_variant).toBe(variant)
    expect(up.values.quoted_cents).toBe(require_('../src/lib/humanDemand.js').PRICE_VARIANTS[variant].forty_eight_hour)
    expect(up.values.cover_letter_quoted_cents).toBe(require_('../src/lib/humanDemand.js').PRICE_VARIANTS[variant].cover_letter)
    // the funnel's last step is recorded by the server, once, for the new row
    const ev = t.db.calls.find(c => c.op === 'insert' && c.table === 'human_demand_events')
    expect(ev.values).toMatchObject({ event: 'waitlist_submitted', tier: 'forty_eight_hour', cover_letter: true, visitor_id: VID, price_variant: variant })
  })

  it('signed in without ticking consent still joins (consent is recorded as false)', async () => {
    setup(joined())
    const res = await t.mod.postWaitlist(ctx({ user: USER, body: { visitorId: VID, tier: 'polish' } }))
    expect(res.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'upsert').values).toMatchObject({ contact_consent: false, cover_letter_interest: false })
  })

  it('a visitor without an account needs a valid email AND the box ticked; the email is stored lower-cased and trimmed', async () => {
    setup(joined())
    expect((await t.mod.postWaitlist(ctx({ body: { visitorId: VID, tier: 'polish', consent: true } }))).status).toBe(400)
    expect((await t.mod.postWaitlist(ctx({ body: { visitorId: VID, tier: 'polish', consent: true, email: 'not-an-email' } }))).status).toBe(400)
    expect((await t.mod.postWaitlist(ctx({ body: { visitorId: VID, tier: 'polish', consent: false, email: 'a@b.co' } }))).status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
    const ok = await t.mod.postWaitlist(ctx({ body: { visitorId: VID, tier: 'seven_day', consent: true, email: '  Jane.Doe@Example.COM ' } }))
    expect(ok.status).toBe(200)
    expect(t.db.calls.find(c => c.op === 'upsert').values).toMatchObject({ identity_key: 'e:jane.doe@example.com', user_id: null, email: 'jane.doe@example.com' })
  })

  it('is idempotent: a second join for the same person and tier creates nothing new, keeps the original quote, and only refreshes cover letter and consent', async () => {
    setup(q => (q.op === 'upsert' ? { data: [], error: null } : undefined))   // the row already exists: ON CONFLICT DO NOTHING returns no row
    const res = await t.mod.postWaitlist(ctx({ user: USER, body: { visitorId: VID, tier: 'polish', coverLetter: true, consent: true } }))
    expect(res.body.data).toEqual({ joined: true, alreadyOnList: true })
    const upd = t.db.calls.find(c => c.op === 'update')
    expect(Object.keys(upd.patch).sort()).toEqual(['contact_consent', 'cover_letter_interest', 'updated_at'])
    expect(upd.filters).toEqual(expect.arrayContaining([['eq', 'identity_key', `u:${USER.id}`], ['eq', 'tier', 'polish']]))
    expect(t.db.calls.find(c => c.op === 'insert' && c.table === 'human_demand_events')).toBeUndefined()   // no second "submitted"
  })

  it('refuses unknown keys, bad tiers and a bad visitor id; refuses with 503 when the sign-in could not be checked', async () => {
    setup(joined())
    for (const body of [
      { visitorId: VID, tier: 'polish', name: 'Jane' }, { visitorId: VID, tier: 'polish', priceVariant: 'low' },
      { visitorId: VID, tier: 'platinum' }, { visitorId: 'bad', tier: 'polish' }, { tier: 'polish' }, null,
    ]) expect((await t.mod.postWaitlist(ctx({ user: USER, body }))).status, JSON.stringify(body)).toBe(400)
    expect((await t.mod.postWaitlist(ctx({ authError: 'unavailable', body: { visitorId: VID, tier: 'polish', consent: true, email: 'a@b.co' } }))).status).toBe(503)
    expect(t.db.calls).toHaveLength(0)
  })

  it('a database failure is an error, not a silent success', async () => {
    setup(q => (q.op === 'upsert' ? { data: null, error: { message: 'boom', code: 'XX000' } } : undefined))
    await expect(t.mod.postWaitlist(ctx({ user: USER, body: { visitorId: VID, tier: 'polish' } }))).rejects.toThrow(/boom/)
  })
})

describe('isolation from money, codes and partners', () => {
  it('none of the new backend files imports a payment, pricing, referral, partner, promo or welcome-code module', async () => {
    const fs = await import('node:fs')
    for (const f of ['src/controllers/human-demand.controller.js', 'src/routes/human-demand.routes.js', 'src/lib/humanDemand.js', 'src/middleware/humanDemandLimits.js']) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')
      const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1])
      for (const r of reqs) expect(r, `${f} requires ${r}`).not.toMatch(/payment|pricing|referral|partner|promo|welcome|commission|webhook|paystack/i)
    }
  })
})
