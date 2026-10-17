// Webhooks round 17 — the independent pass found:
//   G1  a delivery that reaches the app but is REFUSED (bad/rotated signing key, source IP not allowed, over the size cap) left no durable trace;
//       Admin → Webhooks could not say "Paystack is reaching you and every delivery is being refused".
//   B1  the last_attempt_at → received_at downgrade was permanent per Worker instance (a deploy racing migration 0090's schema-cache reload
//       pinned every warm instance to the old clock, bringing the round-16 bug back).
//   B2  recordEvent's retry bump wrote a row another worker had just FINISHED back to RECEIVED.
//   B3  rows whose stored payload had no readable event type were skipped without leaving the re-drive window, so enough of them starved
//       every newer failure for ever.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { createWorld } = require_('./helpers/memoryDb.cjs')
const cryptoLib = require_('../src/lib/crypto.js')

let restore
afterEach(() => { restore?.(); restore = null; vi.useRealTimers(); vi.unstubAllGlobals() })

const SECRET = 'sk_test_round17'
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString()

function loadController(world, extra = {}) {
  const alerts = []
  const l = loadWithStubs('controllers/webhooks.controller.js', {
    'config/supabase.js': { getSupabase: () => world.db },
    'services/email.service.js': { sendOwnerAlert: async (e, subject) => { alerts.push(subject); return true } },
    ...extra,
  })
  restore = l.restore
  return { mod: l.mod, alerts }
}

// ── G1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('G1: webhookRejections helper', () => {
  function loadLib(world, { quota = async () => true } = {}) {
    const l = loadWithStubs('lib/webhookRejections.js', {
      'middleware/rateLimiter.js': { hitQuota: quota },
    })
    restore = l.restore
    return l.mod
  }
  const newWorld = () => { const w = createWorld({ system_state: [] }); w.unique.system_state = [['key']]; return w }

  it('stamps one row per provider with the reason and time, and nothing else', async () => {
    const w = newWorld(); const lib = loadLib(w)
    expect(await lib.recordRejection({}, 'paystack', 'signature', w.db)).toBe(true)
    expect(await lib.recordRejection({}, 'resend', 'unsigned', w.db)).toBe(true)
    const rows = Object.fromEntries(w.t.system_state.map(r => [r.key, r.value]))
    expect(Object.keys(rows).sort()).toEqual(['webhook_rejected:resend', 'webhook_rejected_flagged:paystack'])   // round 18: flagged refusals have their own stamp
    expect(Object.keys(rows['webhook_rejected_flagged:paystack']).sort()).toEqual(['last_at', 'last_reason'])
    expect(rows['webhook_rejected_flagged:paystack'].last_reason).toBe('signature')
  })

  it('is throttled through the shared quota (a flood of junk is not a flood of writes) and ignores unknown providers', async () => {
    const w = newWorld(); let calls = 0
    const lib = loadLib(w, { quota: async () => ++calls === 1 })
    expect(await lib.recordRejection({}, 'paystack', 'signature', w.db)).toBe(true)
    expect(await lib.recordRejection({}, 'paystack', 'signature', w.db)).toBe(false)
    expect(await lib.recordRejection({}, 'stripe', 'signature', w.db)).toBe(false)
    expect(w.t.system_state).toHaveLength(1)
  })

  it('never throws when the database errors', async () => {
    const w = newWorld(); const lib = loadLib(w)
    w.failNext('system_state', 'upsert', { message: 'fetch failed' })
    await expect(lib.recordRejection({}, 'paystack', 'signature', w.db)).resolves.toBe(false)
  })

  it('readRejections reads back what was stamped; a missing row reads as none', async () => {
    const w = newWorld(); const lib = loadLib(w)
    expect(await lib.readRejections(w.db)).toEqual({ paystack: null, resend: null })
    await lib.recordRejection({}, 'paystack', 'ip', w.db)
    const r = await lib.readRejections(w.db)
    expect(r.paystack).toMatchObject({ reason: 'ip' })
    expect(r.resend).toBeNull()
  })

  describe('rejectedSinceLastEvent', () => {
    const now = Date.now()
    const at = h => new Date(now - h * 3600 * 1000).toISOString()
    let lib
    beforeEach(() => { lib = loadLib(newWorld()) })

    it('flags a refusal newer than the last delivery that got through', () => {
      expect(lib.rejectedSinceLastEvent({ paystack: { at: at(1), reason: 'signature' }, resend: null }, { paystack: at(5), resend: null }, now)).toEqual(['paystack'])
    })
    it('flags a refusal when nothing has ever got through', () => {
      expect(lib.rejectedSinceLastEvent({ paystack: null, resend: { at: at(1), reason: 'signature' } }, { paystack: null, resend: null }, now)).toEqual(['resend'])
    })
    it('does not flag once a later delivery got through', () => {
      expect(lib.rejectedSinceLastEvent({ paystack: { at: at(5), reason: 'signature' }, resend: null }, { paystack: at(1), resend: null }, now)).toEqual([])
    })
    it('does not flag scanner-looking refusals (no signature headers, oversized, unreadable) or ones older than 7 days', () => {
      for (const reason of ['unsigned', 'too-large', 'unreadable'])
        expect(lib.rejectedSinceLastEvent({ paystack: { at: at(1), reason }, resend: null }, { paystack: null, resend: null }, now)).toEqual([])
      expect(lib.rejectedSinceLastEvent({ paystack: { at: at(24 * 8), reason: 'signature' }, resend: null }, { paystack: null, resend: null }, now)).toEqual([])
    })
    it('flags a signed-looking refusal and a not-configured secret, but not scanner noise', () => {
      expect(lib.rejectedSinceLastEvent({ paystack: { at: at(1), reason: 'not-configured' }, resend: null }, { paystack: null, resend: null }, now)).toEqual(['paystack'])
    })
    it('recognises provider-shaped requests', () => {
      expect(lib.looksLikePaystackSignature('a'.repeat(128))).toBe(true)
      expect(lib.looksLikePaystackSignature('abc')).toBe(false)
      expect(lib.looksLikePaystackSignature('')).toBe(false)
      expect(lib.looksLikeSvixDelivery({ id: 'm', timestamp: '1', signature: 'v1,x' })).toBe(true)
      expect(lib.looksLikeSvixDelivery({ id: 'm' })).toBe(false)
    })
  })
})

describe('G1: handlePaystack records what it refuses', () => {
  async function fire({ body = '{"event":"transfer.success","data":{}}', sig, headers = {}, env = { PAYSTACK_SECRET_KEY: SECRET } } = {}) {
    const w = createWorld({ webhook_events: [], payments: [], system_state: [] })
    w.unique.webhook_events = [['provider', 'event_key']]; w.unique.system_state = [['key']]
    const { mod } = loadController(w)
    const bytes = new TextEncoder().encode(body)
    const hdr = { ...(sig === null ? {} : { 'x-paystack-signature': sig ?? await cryptoLib.hmacSha512Hex(SECRET, bytes) }), ...headers }
    const pending = []
    const c = {
      env, req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil: p => pending.push(p) }, text: (t, s) => ({ text: t, status: s }),
    }
    const res = await mod.handlePaystack(c); await Promise.all(pending)
    const row = w.t.system_state.find(r => r.key === 'webhook_rejected_flagged:paystack' || r.key === 'webhook_rejected:paystack')
    return { res, row: row && row.value, w }
  }

  it('a well-formed but wrong signature → 401 and a "signature" stamp', async () => {
    const { res, row } = await fire({ sig: 'a'.repeat(128) })
    expect(res.status).toBe(401)
    expect(row.last_reason).toBe('signature')
  })
  it('no signature header at all → 401 and an "unsigned" stamp (scanner-shaped)', async () => {
    const { res, row } = await fire({ sig: null })
    expect(res.status).toBe(401)
    expect(row.last_reason).toBe('unsigned')
  })
  it('a correctly signed request from a blocked IP → 403 and an "ip" stamp', async () => {
    const { res, row } = await fire({ env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_WEBHOOK_IPS: '52.31.139.75' }, headers: { 'cf-connecting-ip': '203.0.113.9' } })
    expect(res.status).toBe(403)
    expect(row.last_reason).toBe('ip')
  })
  it('over the size cap → 413 and a "too-large" stamp', async () => {
    const { res, row } = await fire({ headers: { 'content-length': '99999999' } })
    expect(res.status).toBe(413)
    expect(row.last_reason).toBe('too-large')
  })
  it('missing secret → 500 and a "not-configured" stamp', async () => {
    const { res, row } = await fire({ env: {} })
    expect(res.status).toBe(500)
    expect(row.last_reason).toBe('not-configured')
  })
  it('a valid delivery leaves no stamp', async () => {
    const { res, row } = await fire({})
    expect(res.status).toBe(200)
    expect(row).toBeUndefined()
  })
})

describe('G1: computeWebhookHealth reports refusals since the last accepted delivery', () => {
  const setup = () => {
    const w = createWorld({ webhook_events: [], payments: [], system_state: [] })
    w.unique.system_state = [['key']]
    return { w, ...loadController(w) }
  }
  it('a signature refusal newer than the last event is surfaced, and clears once something gets through', async () => {
    const { w, mod } = setup()
    w.t.webhook_events.push({ id: 'e0', provider: 'paystack', event_key: 'k0', event_type: 'charge.success', reference: 'r0', status: 'PROCESSED', attempts: 1, received_at: hoursAgo(5) })
    w.t.system_state.push({ key: 'webhook_rejected:paystack', value: { last_at: hoursAgo(1), last_reason: 'signature' } })
    let h = await mod.computeWebhookHealth(w.db)
    expect(h.rejectedSinceLastEvent).toEqual(['paystack'])
    expect(h.lastRejected.paystack).toMatchObject({ reason: 'signature' })

    // the in-memory double ignores .order(): newest first is what `order received_at desc limit 1` would return
    w.t.webhook_events.unshift({ id: 'e1', provider: 'paystack', event_key: 'k1', event_type: 'charge.success', reference: 'r1', status: 'PROCESSED', attempts: 1, received_at: hoursAgo(0.1) })
    h = await mod.computeWebhookHealth(w.db)
    expect(h.rejectedSinceLastEvent).toEqual([])
  })
  it('with no stamps the fields are present and empty', async () => {
    const { w, mod } = setup()
    const h = await mod.computeWebhookHealth(w.db)
    expect(h.rejectedSinceLastEvent).toEqual([])
    expect(h.lastRejected).toEqual({ paystack: null, resend: null })
  })
})

describe('G1: handleResend records what it refuses', () => {
  async function fire({ headers, env = { RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('k').toString('base64') } }) {
    const w = createWorld({ webhook_events: [], system_state: [] })
    w.unique.webhook_events = [['provider', 'event_key']]; w.unique.system_state = [['key']]
    const l = loadWithStubs('controllers/resend-webhook.controller.js', {
      'config/supabase.js': { getSupabase: () => w.db },
      'services/email.service.js': { sendOwnerAlert: async () => true },
    })
    restore = l.restore
    const bytes = new TextEncoder().encode('{"type":"email.bounced","data":{}}')
    const hdr = headers || {}
    const pending = []
    const c = {
      env, req: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), header: h => hdr[h.toLowerCase()] },
      executionCtx: { waitUntil: p => pending.push(p) }, text: (t, s) => ({ text: t, status: s }),
    }
    const res = await l.mod.handleResend(c); await Promise.all(pending)
    const row = w.t.system_state.find(r => r.key === 'webhook_rejected_flagged:resend' || r.key === 'webhook_rejected:resend')
    return { res, row: row && row.value }
  }
  it('bad signature with svix headers → 401 + "signature"', async () => {
    const { res, row } = await fire({ headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' } })
    expect(res.status).toBe(401)
    expect(row.last_reason).toBe('signature')
  })
  it('no svix headers → 401 + "unsigned"', async () => {
    const { res, row } = await fire({ headers: {} })
    expect(res.status).toBe(401)
    expect(row.last_reason).toBe('unsigned')
  })
  it('missing secret → 500 + "not-configured"', async () => {
    const { res, row } = await fire({ headers: {}, env: {} })
    expect(res.status).toBe(500)
    expect(row.last_reason).toBe('not-configured')
  })
})

// ── B1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B1: the stale-column downgrade expires', () => {
  const colMissing = { code: 'PGRST204', message: "Could not find the 'last_attempt_at' column of 'webhook_events' in the schema cache" }
  const failedRow = () => ({ id: 'e1', provider: 'paystack', event_key: 'charge.success:1', event_type: 'charge.success', reference: 'r1', status: 'FAILED', attempts: 1, redrives: 0, received_at: hoursAgo(3), payload: {} })
  const retry = (mod, w) => mod.recordEvent(w.db, { eventKey: 'charge.success:1', eventType: 'charge.success', reference: 'r1', payload: {} })

  it('after a schema-cache miss the clock falls back, then probes the real column again once the retry interval has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    const w = createWorld({ payments: [], webhook_events: [failedRow()] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = loadController(w)

    w.failNext('webhook_events', 'update', colMissing)
    expect((await retry(mod, w)).mode).toBe('retry')
    expect(w.t.webhook_events[0].last_attempt_at).toBeUndefined()          // downgraded: written without the column

    await retry(mod, w)
    expect(w.t.webhook_events[0].last_attempt_at).toBeUndefined()          // still inside the window: still the old clock

    vi.setSystemTime(new Date(Date.now() + mod.STALE_COL_RETRY_MS + 1000))
    await retry(mod, w)
    expect(Date.parse(w.t.webhook_events[0].last_attempt_at)).toBe(Date.now())   // probed again: the column is back in use
  })

  it('a column that is genuinely still missing is re-downgraded (one failed probe per interval, not per request)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'))
    const w = createWorld({ payments: [], webhook_events: [failedRow()] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = loadController(w)
    w.failNext('webhook_events', 'update', colMissing)
    await retry(mod, w)
    vi.setSystemTime(new Date(Date.now() + mod.STALE_COL_RETRY_MS + 1000))
    w.failNext('webhook_events', 'update', colMissing)
    expect((await retry(mod, w)).mode).toBe('retry')                       // probe failed → falls back again, request still served
    await retry(mod, w)
    expect(w.t.webhook_events[0].last_attempt_at).toBeUndefined()
  })
})

// ── B2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B2: a retry bump never reopens a finished row', () => {
  function fakeDb({ bumpedRows, rereadStatus = 'PROCESSED' }) {
    const updates = []
    return {
      updates,
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }),
        select: cols => (cols === 'status'
          ? { eq: () => ({ maybeSingle: async () => ({ data: { status: rereadStatus }, error: null }) }) }
          : { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'e1', status: 'FAILED', attempts: 1 }, error: null }) }) }) }),
        update: patch => {
          const q = { filters: [], eq: () => q, in: (col, vals) => { q.filters.push([col, vals]); return q }, select: async () => { updates.push({ patch, filters: q.filters }); return { data: bumpedRows, error: null } } }
          return q
        },
      }),
    }
  }
  const call = db => { const { mod } = loadController(createWorld({})); return mod.recordEvent(db, { eventKey: 'k', eventType: 'charge.success', reference: 'r', payload: {} }) }

  it('the bump is conditional on the row still being FAILED/RECEIVED', async () => {
    const db = fakeDb({ bumpedRows: [{ id: 'e1' }] })
    const r = await call(db)
    expect(r.mode).toBe('retry')
    expect(db.updates[0].filters).toEqual([['status', ['FAILED', 'RECEIVED']]])
  })
  it('when another worker finished the row in the meantime this delivery is a duplicate ("done"), not a reopen', async () => {
    const r = await call(fakeDb({ bumpedRows: [] }))
    expect(r.mode).toBe('done')
  })
  it('zero rows moved but the row is NOT finished (unknown state) → still processed as a retry, never silently dropped', async () => {
    const r = await call(fakeDb({ bumpedRows: [], rereadStatus: 'RECEIVED' }))
    expect(r.mode).toBe('retry')
  })
  it('end to end: a row that is PROCESSED is never written back to RECEIVED', async () => {
    const w = createWorld({ payments: [], webhook_events: [{ id: 'e1', provider: 'paystack', event_key: 'k', event_type: 'charge.success', reference: 'r', status: 'PROCESSED', attempts: 1, received_at: hoursAgo(1) }] })
    w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = loadController(w)
    expect((await mod.recordEvent(w.db, { eventKey: 'k', eventType: 'charge.success', reference: 'r', payload: {} })).mode).toBe('done')
    expect(w.t.webhook_events[0].status).toBe('PROCESSED')
  })
})

// ── B3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('B3: rows that can never be re-run leave the re-drive window', () => {
  const row = o => ({ id: 'u1', provider: 'paystack', event_key: 'charge.success:9', event_type: 'charge.success', reference: 'rX', status: 'FAILED', attempts: 1, redrives: 0, received_at: hoursAgo(5), payload: { not: 'an event' }, ...o })

  it('an unreadable stored payload is closed as IGNORED with a note and the owner is told (it is a money event)', async () => {
    const w = createWorld({ payments: [], webhook_events: [row()] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod, alerts } = loadController(w)
    const out = await mod.redriveStaleEvents({}, { waitUntil() {} })
    expect(out.unrunnableClosed).toContain('u1')
    expect(w.t.webhook_events[0]).toMatchObject({ status: 'IGNORED', note: expect.stringMatching(/not a replayable event/) })
    expect(alerts.some(s => /could not be re-run/.test(s))).toBe(true)
  })

  it('a non-money event with an unreadable payload is closed quietly', async () => {
    const w = createWorld({ payments: [], webhook_events: [row({ event_type: 'subscription.create', event_key: 'sub:1' })] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod, alerts } = loadController(w)
    const out = await mod.redriveStaleEvents({}, { waitUntil() {} })
    expect(out.unrunnableClosed).toContain('u1')
    expect(alerts.some(s => /could not be re-run/.test(s))).toBe(false)
  })

  it('a row another worker finished meanwhile is not closed', async () => {
    const w = createWorld({ payments: [], webhook_events: [row({ status: 'PROCESSED' })] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = loadController(w)
    expect(await mod.closeUnreadableStored(w.db, [row()])).toEqual([])
    expect(w.t.webhook_events[0].status).toBe('PROCESSED')
  })

  it('unreadable rows no longer crowd newer failures out of the window', async () => {
    const junk = Array.from({ length: 40 }, (_, i) => row({ id: `u${i}`, event_key: `junk:${i}`, received_at: hoursAgo(50 + i) }))
    const good = row({ id: 'g1', event_key: 'refund.processed:77', event_type: 'refund.processed', reference: 'rG', received_at: hoursAgo(5), payload: { event: 'transfer.success', data: {} } })
    const w = createWorld({ payments: [], webhook_events: [...junk, good] }); w.unique.webhook_events = [['provider', 'event_key']]
    const { mod } = loadController(w)
    const out = await mod.redriveStaleEvents({}, { waitUntil() {} })
    expect(out.redriven).toContain('g1')             // the readable row behind 40 unreadable ones is still re-driven
  })
})
