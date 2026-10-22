import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// The owner alert for "migration NNNN was never recorded as applied": it used to say "expects 106; reports 106" and then tell the owner to
// run every file ABOVE the reported number (there are none - the gap is below it), under a subject claiming the schema was behind the
// code, and it re-sent every hourly cron tick because the throttle is 10 minutes.

const c = require('../src/config/constants')
const { LEDGER_NAMES } = require('../src/config/migrationLedger')
const E = c.EXPECTED_SCHEMA_VERSION
const ledger = skip => Array.from({ length: E - 82 + 1 }, (_, i) => 82 + i).filter(v => !skip.includes(v)).map(v => ({ version: v, name: LEDGER_NAMES[v] || `${v}` }))

describe('the hourly health sweep', () => {
  const sbPath = require.resolve('../src/config/supabase.js')
  const real = require('../src/config/supabase.js')
  const email = require('../src/services/email.service.js')
  const state = { db: null }
  require.cache[sbPath].exports = { ...real, getSupabase: () => state.db }
  afterEach(() => vi.restoreAllMocks())

  async function sweep({ version = E, skip = [] }) {
    state.db = createFakeSupabase(q => {
      if (q.table === 'system_state') return { data: { value: { version } }, error: null }
      if (q.table === 'applied_migrations') return { data: ledger(skip), error: null }
      return undefined
    })
    const alerts = []
    vi.spyOn(email, 'sendOwnerAlert').mockImplementation(async (...a) => { alerts.push(a); return true })
    const { default: worker } = await import('../src/index.js')
    const pending = []
    worker.scheduled({ cron: '0 * * * *' }, { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'j'.repeat(40), FRONTEND_URL: 'https://x.test' }, { waitUntil: p => pending.push(p) })
    await Promise.allSettled(pending)
    return alerts.filter(a => /schema|migration/i.test(a[1]))
  }

  it('a skipped migration BELOW the reported version is named, with its file, and is not described as "behind the code"', async () => {
    const [a] = await sweep({ skip: [85] })
    const [, subject, body, opts] = a
    expect(subject).toBe('A database migration was never recorded as applied')
    expect(body).toContain('0085 (supabase/migrations/0085_partners_section4_round14.sql)')
    expect(body).toMatch(/version numbers match/)
    expect(body).not.toMatch(/above the reported number/)        // there is nothing above it to run
    expect(opts.dedupeKey).toContain('85')
  })
  it('it is throttled to once a day, not once an hourly tick', async () => {
    const [a] = await sweep({ skip: [85] })
    expect(a[3].dedupeSeconds).toBe(24 * 3600)
  })
  it('a database that really is BEHIND the code keeps the original wording', async () => {
    const [a] = await sweep({ version: E - 1 })
    expect(a[1]).toBe('Database schema is behind the deployed code')
    expect(a[2]).toMatch(/above the reported number/)
  })
  it('a healthy database sends nothing', async () => {
    expect(await sweep({})).toHaveLength(0)
  })
})

describe('sendOwnerAlert dedupe window', () => {
  function kv() { const m = new Map(); return { get: async k => { const e = m.get(k); return e && (!e.exp || e.exp > Date.now()) ? e.v : null }, put: async (k, v, o) => { m.set(k, { v, exp: o && o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }) }, delete: async k => { m.delete(k) } } }
  let t
  afterEach(() => { vi.useRealTimers(); t?.restore() })
  function setup() {
    const sent = []
    const db = createFakeSupabase()
    const { mod, restore } = loadWithStubs('services/email.service.js', {
      'config/email.js': { sendViaResend: async (env, msg) => { sent.push(msg); return { id: 'x' } } },
      'config/supabase.js': { getSupabase: () => db },
    })
    return { mod, restore, sent, env: { FRONTEND_URL: 'https://x.test', EMAIL_FROM: 'P <a@b.co>', OWNER_ALERT_EMAIL: 'owner@example.com', RATE_LIMIT_KV: kv() } }
  }
  const at = (min) => vi.setSystemTime(new Date(Date.parse('2026-10-22T10:00:00Z') + min * 60000))

  it('by default the same alert is emailed again after 10 minutes - the hourly cron re-sent a standing condition 24 times a day', async () => {
    vi.useFakeTimers(); at(0); t = setup()
    expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm')).toBe(true)
    at(5);  expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm')).toBe(false)
    at(61); expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm')).toBe(true)
  })
  it('with dedupeSeconds it is held back for that long, then sent again', async () => {
    vi.useFakeTimers(); at(0); t = setup()
    const opts = { dedupeSeconds: 24 * 3600 }
    expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm', opts)).toBe(true)
    at(61);        expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm', opts)).toBe(false)   // the next hourly tick
    at(12 * 60);   expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm', opts)).toBe(false)
    at(24 * 60 + 5); expect(await t.mod.sendOwnerAlert(t.env, 'standing condition', 'm', opts)).toBe(true)   // a daily reminder
    expect(t.sent).toHaveLength(2)
  })
  it('a caller can stretch the window but never shorten it below 10 minutes, and it is capped at a week', async () => {
    vi.useFakeTimers(); at(0); t = setup()
    expect(await t.mod.sendOwnerAlert(t.env, 'short', 'm', { dedupeSeconds: 1 })).toBe(true)
    at(5); expect(await t.mod.sendOwnerAlert(t.env, 'short', 'm', { dedupeSeconds: 1 })).toBe(false)
    at(0); expect(await t.mod.sendOwnerAlert(t.env, 'long', 'm', { dedupeSeconds: 99 * 86400 })).toBe(true)
    at(8 * 24 * 60); expect(await t.mod.sendOwnerAlert(t.env, 'long', 'm', { dedupeSeconds: 99 * 86400 })).toBe(true)
  })
})
