import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const c = require('../src/config/constants')
const promoConfig = require('../src/lib/promoConfig')
const ctrl = require('../src/controllers/admin-promo.controller')

const NOW = Date.UTC(2026, 10, 1, 12)
const FUTURE = new Date(NOW + 7 * 864e5).toISOString()
const deployEnv = { PAYSTACK_CURRENCY: 'USD', PROMO_ACTIVE: 'false', PROMO_ENDS_AT: '2026-11-22T23:59:59Z' }
const good = { active: true, label: 'Black Friday', endsAt: FUTURE, prices: { FIX: 2500, BADGE: 700, FIX_PLAIN: 1500 } }

beforeEach(() => promoConfig.invalidate())

describe('promoConfig', () => {
  it('reads the stored record once per TTL and serves it from cache', async () => {
    const db = createFakeSupabase(q => ({ data: { value: { ...good, currency: 'USD' } } }))
    expect((await promoConfig.current(db, 1000)).label).toBe('Black Friday')
    await promoConfig.current(db, 1000 + 29_000)
    expect(db.calls).toHaveLength(1)
    await promoConfig.current(db, Date.now() + 31_000)
    expect(db.calls).toHaveLength(2)
  })
  it('ignores a malformed record', async () => {
    const db = createFakeSupabase(() => ({ data: { value: { nonsense: 1 } } }))
    expect(await promoConfig.current(db)).toBeNull()
  })
  it('never throws: a failed read serves the last good record (or null)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = createFakeSupabase(() => ({ data: null, error: new Error('down') }))
    expect(await promoConfig.current(db)).toBeNull()
  })
  it('overlayEnv copies env, never mutates it, and is a no-op without a record', () => {
    expect(promoConfig.overlayEnv(deployEnv, null)).toBe(deployEnv)
    const out = promoConfig.overlayEnv(deployEnv, { ...good, currency: 'USD', startsAt: null })
    expect(out).not.toBe(deployEnv)
    expect(deployEnv.PROMO_ACTIVE).toBe('false')
    expect(out.__promoSource).toBe('admin')
    expect(out.__deployPromo).toEqual({ active: false, endsAt: '2026-11-22T23:59:59Z' })
  })
  it('save upserts and primes the cache; clear deletes', async () => {
    const db = createFakeSupabase()
    await promoConfig.save(db, good)
    expect(db.calls[0]).toMatchObject({ table: 'system_state', op: 'upsert', onConflict: 'key' })
    expect(await promoConfig.current(db)).toEqual(good)
    await promoConfig.clear(db)
    expect(db.calls[1].op).toBe('delete')
    expect(await promoConfig.current(db)).toBeNull()
  })
})

describe('pricing through the overlay', () => {
  const env = promoConfig.overlayEnv(deployEnv, { ...good, currency: 'USD', startsAt: null })
  it('uses the admin prices and label while active', () => {
    const real = Date.now
    Date.now = () => NOW
    try {
      expect(c.isPromoActive(env)).toBe(true)
      expect(c.priceForTier('FIX', env)).toBe(2500)
      expect(c.priceTable(env).promo.BADGE).toBe(700)
      expect(c.promoLabel(env)).toBe('Black Friday')
    } finally { Date.now = real }
  })
  it('is off before its scheduled start', () => {
    const e = promoConfig.overlayEnv(deployEnv, { ...good, currency: 'USD', startsAt: new Date(NOW + 864e5).toISOString() })
    const real = Date.now
    Date.now = () => NOW
    try { expect(c.isPromoActive(e)).toBe(false) } finally { Date.now = real }
  })
  it('falls back to the default label and deploy prices with no record', () => {
    expect(c.promoLabel(deployEnv)).toBe('Introductory price')
  })
})

describe('admin-promo validate', () => {
  const v = (patch, now = NOW) => ctrl.validate({ ...good, ...patch }, deployEnv, now)
  it('accepts a good promo and normalises it', () => {
    const r = v({ label: '  Black   Friday ' })
    expect(r.ok).toBe(true)
    expect(r.record).toMatchObject({ label: 'Black Friday', currency: 'USD', prices: good.prices })
  })
  it('rejects prices at or above standard, or below the floor', () => {
    const std = c.priceTable(deployEnv).standard
    expect(v({ prices: { ...good.prices, FIX: std.FIX } }).errors[0].field).toBe('prices.FIX')
    expect(v({ prices: { ...good.prices, BADGE: 50 } }).errors[0].field).toBe('prices.BADGE')
  })
  it('rejects a past end only when active, and a start after the end', () => {
    expect(v({ endsAt: new Date(NOW - 1000).toISOString() }).errors[0].field).toBe('endsAt')
    expect(v({ active: false, endsAt: new Date(NOW - 1000).toISOString() }).ok).toBe(true)
    expect(v({ startsAt: new Date(NOW + 30 * 864e5).toISOString() }).errors[0].field).toBe('startsAt')
  })
  it('rejects markup in the label, junk dates and wrong types', () => {
    expect(v({ label: '<b>x</b>' }).errors[0].field).toBe('label')
    expect(v({ endsAt: 'soon' }).errors[0].field).toBe('endsAt')
    expect(v({ prices: { FIX: '25', BADGE: 1, FIX_PLAIN: 1 } }).ok).toBe(false)
    expect(v({ label: 'x'.repeat(41) }).ok).toBe(false)
  })
})

describe('admin-promo handlers', () => {
  const mkCtx = (db, body) => {
    const out = {}
    return { out, env: { ...deployEnv, SUPABASE_URL: 'x' }, req: { json: async () => { if (body === 'bad') throw new Error('x'); return body } },
      get: () => ({ id: 'admin-1' }), json: (b, s = 200) => { out.body = b; out.status = s; return out } }
  }
  // The controller destructures getSupabase at load time, so the fake is injected by loading it with a stub.
  const withDb = async (db, fn) => {
    const loaded = loadWithStubs('controllers/admin-promo.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
    try { return await fn(loaded.mod) } finally { loaded.restore() }
  }
  it('PUT saves, audits and returns the effective promo', async () => {
    const db = createFakeSupabase()
    const realNow = Date.now; Date.now = () => NOW
    try {
      const ctx = mkCtx(db, good)
      await withDb(db, m => m.adminSetPromo(ctx))
      expect(ctx.out.status).toBe(200)
      expect(ctx.out.body.data.effective).toMatchObject({ active: true, label: 'Black Friday', source: 'admin' })
      expect(db.calls.map(q => `${q.table}:${q.op}`)).toEqual(['system_state:upsert', 'admin_audit_log:insert'])
      expect(db.calls[1].values).toMatchObject({ action: 'promo.update', actor_id: 'admin-1' })
    } finally { Date.now = realNow }
  })
  it('PUT answers 400 with per-field errors and writes nothing', async () => {
    const db = createFakeSupabase()
    const ctx = mkCtx(db, { ...good, prices: { ...good.prices, FIX: 999999 } })
    await withDb(db, m => m.adminSetPromo(ctx))
    expect(ctx.out.status).toBe(400)
    expect(ctx.out.body.errors[0].field).toBe('prices.FIX')
    expect(db.calls).toHaveLength(0)
  })
  it('PUT with a non-JSON body is a 400', async () => {
    const ctx = mkCtx(createFakeSupabase(), 'bad')
    await ctrl.adminSetPromo(ctx)
    expect(ctx.out.status).toBe(400)
  })
  it('DELETE removes the record, audits, and reports deploy source', async () => {
    const db = createFakeSupabase()
    const ctx = mkCtx(db)
    await withDb(db, m => m.adminClearPromo(ctx))
    expect(ctx.out.body.data.saved).toBeNull()
    expect(ctx.out.body.data.effective.source).toBe('deploy')
    expect(db.calls[1].values.action).toBe('promo.clear')
  })
  it('GET shows saved vs effective vs deploy, and 503s if the table cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = { ...good, currency: 'USD', startsAt: null }
    const db = createFakeSupabase(() => ({ data: { value: stored } }))
    const ctx = mkCtx(db)
    await withDb(db, m => m.adminGetPromo(ctx))
    expect(ctx.out.body.data).toMatchObject({ saved: stored, deploy: { active: false } })
    expect(ctx.out.body.data.effective.source).toBe('admin')
    const bad = createFakeSupabase(() => ({ data: null, error: new Error('x') }))
    const ctx2 = mkCtx(bad)
    await withDb(bad, m => m.adminGetPromo(ctx2))
    expect(ctx2.out.status).toBe(503)
  })
})
