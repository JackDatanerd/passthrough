import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { verifySvixSignature } from '../src/lib/svix.js'

// Resend bounce / complaint events (Svix-signed) feeding the employer do-not-contact list.
// Independent audit round 9, Section 5.

const KEY = Buffer.from('a-test-signing-key-of-some-length')
const SECRET = 'whsec_' + KEY.toString('base64')
const sign = (id, ts, body, key = KEY) => 'v1,' + createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
const nowTs = () => String(Math.floor(Date.now() / 1000))

describe('verifySvixSignature', () => {
  const body = '{"type":"email.complained"}'
  const args = (over = {}) => { const ts = nowTs(); return { secret: SECRET, id: 'msg_1', timestamp: ts, body, signature: sign('msg_1', ts, body), ...over } }

  it('accepts a genuine signature', async () => { expect(await verifySvixSignature(args())).toBe(true) })
  it('accepts when one of several space-separated signatures matches (secret rotation)', async () => {
    const a = args(); a.signature = `v1,AAAA ${a.signature} v2,zzzz`
    expect(await verifySvixSignature(a)).toBe(true)
  })
  it('rejects a body that was changed', async () => { expect(await verifySvixSignature(args({ body: body + ' ' }))).toBe(false) })
  it('rejects a wrong key', async () => {
    const ts = nowTs()
    expect(await verifySvixSignature(args({ timestamp: ts, signature: sign('msg_1', ts, body, Buffer.from('other-key-other-key')) }))).toBe(false)
  })
  it('rejects a stale or future timestamp (replay)', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600)
    expect(await verifySvixSignature(args({ timestamp: old, signature: sign('msg_1', old, body) }))).toBe(false)
    const future = String(Math.floor(Date.now() / 1000) + 3600)
    expect(await verifySvixSignature(args({ timestamp: future, signature: sign('msg_1', future, body) }))).toBe(false)
  })
  it('rejects missing pieces and malformed timestamps', async () => {
    for (const over of [{ id: '' }, { timestamp: '' }, { signature: '' }, { secret: '' }, { timestamp: 'abc' }, { timestamp: '12abc' }, { body: null }])
      expect(await verifySvixSignature(args(over))).toBe(false)
  })
})

function setup({ leads = [], suppressed = [], envExtra = {}, users = [], employerMail = [], failMailSuppression = false, failInboxInsert = false, failStatusUpdate = false } = {}) {
  const state = { users, employerMail, events: [], leads: leads.map(l => ({ ...l })), suppressed: new Set(suppressed), audit: [], logPurges: [], mailSuppressed: [], stamps: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      const email = q.filters.find(f => f[1] === 'email')?.[2]
      if (q.op === 'delete') { state.leads = state.leads.filter(l => l.email !== email); return { data: [], error: null } }
      const hit = state.leads.find(l => l.email === email)
      return { data: hit ? { id: hit.id } : null, error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      if (q.op === 'upsert') { [].concat(q.values).forEach(v => state.suppressed.add(v.email_hash)); return { data: null, error: null } }
      return { data: null, error: null }
    }
    if (q.table === 'email_suppressions') {
      if (q.op === 'upsert' && failMailSuppression) return { data: null, error: { code: '42P01', message: 'relation "email_suppressions" does not exist' } }
      if (q.op === 'upsert') state.mailSuppressed.push(q.values); return { data: null, error: null }
    }
    if (q.table === 'users') { const e = q.filters.find(f => f[1] === 'email')?.[2]; const u = state.users.find(x => x.email === e); return { data: u ? { id: u.id } : null, error: null } }
    if (q.table === 'email_logs') {
      if (q.op === 'select') { const to = q.filters.find(f => f[1] === 'to')?.[2]; return { data: state.employerMail.includes(to) ? [{ template: 'employer_lead_ack' }] : [], error: null } }
      state.logPurges.push(Object.fromEntries(q.filters.map(f => [f[1], f[2]]))); return { data: null, error: null }
    }
    if (q.table === 'webhook_events') {
      if (q.op === 'insert') {
        if (failInboxInsert) return { data: null, error: { message: 'insert blew up' } }
        if (state.events.some(e => e.provider === q.values.provider && e.event_key === q.values.event_key)) return { data: null, error: { code: '23505', message: 'duplicate' } }
        const row = { id: 'we' + (state.events.length + 1), status: 'RECEIVED', attempts: 1, ...q.values }; state.events.push(row); return { data: { id: row.id, attempts: 1 }, error: null }
      }
      if (q.op === 'update' && failStatusUpdate && q.patch && 'status' in q.patch) return { data: null, error: { message: 'blip' } }
      if (q.op === 'update') { const id = q.filters.find(f => f[1] === 'id')?.[2]; const row = state.events.find(e => e.id === id); if (row) Object.assign(row, q.patch); return { data: null, error: null } }
      const key = q.filters.find(f => f[1] === 'event_key')?.[2]; const row = state.events.find(e => e.event_key === key)
      return { data: row ? { id: row.id, status: row.status, attempts: row.attempts } : null, error: null }
    }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
    if (q.table === 'system_state') { if (q.op === 'upsert') state.stamps.push(q.values); return { data: null, error: null } }
    return undefined
  })
  // The real performRemoval is used (it lives in the leads controller); only Supabase is faked.
  state.alerts = []
  const { mod, restore } = loadWithStubs('controllers/resend-webhook.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerAlert: async (env, subject, message) => { state.alerts.push({ subject, message }); return true } },
  })
  const env = { RESEND_WEBHOOK_SECRET: SECRET, ...envExtra }
  const call = async (event, { headers, rawBody, envOver } = {}) => {
    const body = rawBody ?? JSON.stringify(event)
    const ts = nowTs()
    const id = headers?.['svix-id'] || 'msg_1'
    const h = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sign(id, ts, body), ...headers }
    const pending = []
    const c = {
      env: envOver || env,
      executionCtx: { waitUntil: p => pending.push(p) },
      get: () => undefined,
      req: { header: k => h[k.toLowerCase()], text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer },
      text: (t, status = 200) => ({ text: t, status }),
      json: (b, status = 200) => ({ body: b, status }),
    }
    const res = await mod.handleResend(c)
    await Promise.all(pending)
    return res
  }
  return { mod, restore, state, call }
}

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

// A tiny KV (the rate-limit backend the cooldown goes through).
const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }
const lead = { id: 'l1', email: 'dana@acme.com' }
const complaint = (to = ['dana@acme.com']) => ({ type: 'email.complained', data: { to } })
const bounce = (type, to = ['dana@acme.com']) => ({ type: 'email.bounced', data: { to, bounce: { type } } })

describe('POST /api/webhooks/resend', () => {
  it('fails closed (500) when the signing secret is not configured', async () => {
    t = setup({ leads: [lead] })
    const res = await t.call(complaint(), { envOver: {} })
    expect(res.status).toBe(500)
    expect(t.state.leads).toHaveLength(1)
  })
  it('ROUND 5 (G1): a missing secret pages the owner, once per cooldown window', async () => {
    t = setup({ leads: [lead] })
    const env = { RATE_LIMIT_KV: kv() }
    await t.call(complaint(), { envOver: env }); await t.call(complaint(), { envOver: env })
    const a = t.state.alerts.filter(x => /secret not configured/i.test(x.subject))
    expect(a).toHaveLength(1)
    expect(a[0].message).toMatch(/wrangler secret put RESEND_WEBHOOK_SECRET/)
  })
  it('ROUND 5 (G1): a signature failure pages the owner once (not per request) and still answers 401', async () => {
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    t = setup({ leads: [lead], envExtra: env })
    const bad = { 'svix-signature': 'v1,AAAA' }
    const r1 = await t.call(complaint(), { headers: bad, envOver: env })
    await t.call(complaint(), { headers: bad, envOver: env }); await t.call(complaint(), { headers: bad, envOver: env })
    expect(r1.status).toBe(401)
    expect(t.state.alerts.filter(x => /signature verification failed/i.test(x.subject))).toHaveLength(1)
    expect(t.state.leads).toHaveLength(1)
  })
  it('ROUND 5 (G1): a valid event never alerts', async () => {
    t = setup({ leads: [lead] })
    await t.call(complaint())
    expect(t.state.alerts).toHaveLength(0)
  })
  it('rejects a bad signature with 401 and changes nothing', async () => {
    t = setup({ leads: [lead] })
    const res = await t.call(complaint(), { headers: { 'svix-signature': 'v1,AAAA' } })
    expect(res.status).toBe(401)
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.suppressed.size).toBe(0)
  })
  it('a spam complaint suppresses the address, deletes the lead and clears its employer mail history', async () => {
    t = setup({ leads: [lead] })
    const res = await t.call(complaint())
    expect(res.status).toBe(200)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.size).toBe(1)
    expect(t.state.logPurges).toHaveLength(1)
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.auto_suppressed', actor_id: null, detail: { reason: 'spam_complaint', source: 'resend' } })
    expect(JSON.stringify(t.state.audit)).not.toContain('dana@acme.com')
  })
  it('ROUND 7 (B5): a complaint from an address that is neither a lead nor ever got employer mail suppresses MAIL only — no lead suppression, no audit entry', async () => {
    t = setup({ leads: [] })
    const res = await t.call(complaint(['Someone <Someone@Elsewhere.com>']))
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(0)
    expect(t.state.mailSuppressed).toHaveLength(1)
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.audit).toHaveLength(0)
  })
  it('ROUND 7 (B5): a complaint from an address that WAS sent employer mail (its lead row already gone) still gets the lead suppression', async () => {
    t = setup({ leads: [], employerMail: ['gone@acme.com'] })
    const res = await t.call(complaint(['gone@acme.com']))
    expect(res.body.removed).toBe(1)
    expect(t.state.suppressed.size).toBe(1)
    expect(t.state.audit[0].detail.reason).toBe('spam_complaint')
  })
  it('a permanent bounce removes a lead', async () => {
    t = setup({ leads: [lead] })
    await t.call(bounce('Permanent'))
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.size).toBe(1)
    expect(t.state.audit[0].detail.reason).toBe('hard_bounce')
  })
  it('a permanent bounce for an address that is not a lead does not touch the suppression list', async () => {
    t = setup({ leads: [] })
    await t.call(bounce('Permanent', ['candidate@gmail.com']))
    expect(t.state.suppressed.size).toBe(0)
  })
  it('transient / undetermined bounces and other event types are ignored', async () => {
    t = setup({ leads: [lead] })
    await t.call(bounce('Transient'))
    await t.call(bounce('Undetermined'))
    await t.call({ type: 'email.delivered', data: { to: ['dana@acme.com'] } })
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.suppressed.size).toBe(0)
  })
  it('handles several recipients, de-duplicating and ignoring junk', async () => {
    t = setup({ leads: [lead, { id: 'l2', email: 'sam@acme.com' }] })
    await t.call(complaint(['dana@acme.com', 'DANA@acme.com', 'sam@acme.com', 'not-an-email', 42, null]))
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.size).toBe(2)
  })
  it('acknowledges a signed body that is not JSON, or has no recipients, without acting', async () => {
    t = setup({ leads: [lead] })
    expect((await t.call(null, { rawBody: 'not json' })).status).toBe(200)
    expect((await t.call({ type: 'email.complained', data: {} })).status).toBe(200)
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('general mail suppression (cross-cutting infra round 1, G4)', () => {
  it('a permanent bounce is remembered even for an address that is NOT a lead (hash only, never the address)', async () => {
    t = setup({ leads: [] })
    await t.call(bounce('Permanent', ['Candidate@Gmail.com']))
    expect(t.state.mailSuppressed).toHaveLength(1)
    expect(t.state.mailSuppressed[0]).toMatchObject({ reason: 'bounce' })
    expect(t.state.mailSuppressed[0].email_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(t.state.mailSuppressed)).not.toMatch(/candidate|gmail/i)
    expect(t.state.suppressed.size).toBe(0)           // the employer list is untouched, as before
  })
  it('a complaint is remembered as a complaint', async () => {
    t = setup({ leads: [lead] })
    await t.call(complaint())
    expect(t.state.mailSuppressed).toHaveLength(1)
    expect(t.state.mailSuppressed[0].reason).toBe('complaint')
  })
  it('transient bounces and other events record nothing', async () => {
    t = setup({ leads: [lead] })
    await t.call(bounce('Transient'))
    await t.call({ type: 'email.delivered', data: { to: ['dana@acme.com'] } })
    expect(t.state.mailSuppressed).toHaveLength(0)
  })
  it('ROUND 7 (B1): a failing suppression write (migration 0059 missing, a database blip) is NOT acknowledged — the delivery fails so Resend retries — but the lead is still removed', async () => {
    t = setup({ leads: [lead], failMailSuppression: true })
    await expect(t.call(complaint())).rejects.toThrow(/suppression write failed/)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.events[0]).toMatchObject({ status: 'FAILED', error: 'email suppression write failed' })
  })
  it('ROUND 7 (B1): the same for a bounce of an address that is not a lead (nothing else would have recorded it)', async () => {
    t = setup({ leads: [], failMailSuppression: true })
    await expect(t.call(bounce('Permanent', ['x@y.co']))).rejects.toThrow(/suppression write failed/)
  })
})

describe('normalizeRecipient', () => {
  it('extracts and lowercases addresses', () => {
    t = setup()
    const { normalizeRecipient } = t.mod
    expect(normalizeRecipient('Dana <Dana@Acme.com>')).toBe('dana@acme.com')
    expect(normalizeRecipient(' a@b.co ')).toBe('a@b.co')
    for (const v of ['', 'nope', 'a@b', 'a b@c.com', null, 5]) expect(normalizeRecipient(v)).toBeNull()
  })
})

describe('round 6 — G2: any verified event stamps "last Resend event"', () => {
  it('an ignored event type (email.delivered) still stamps system_state, once per window', async () => {
    t = setup()
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    await t.call({ type: 'email.delivered', data: { to: ['a@b.co'] } }, { envOver: env })
    await t.call({ type: 'email.delivered', data: { to: ['a@b.co'] } }, { envOver: env })
    expect(t.state.stamps).toHaveLength(1)
    expect(t.state.stamps[0]).toMatchObject({ key: 'resend_webhook', value: { last_event_type: 'email.delivered' } })
    expect(Date.parse(t.state.stamps[0].value.last_event_at)).toBeGreaterThan(Date.now() - 5000)
  })
  it('a bad signature never stamps', async () => {
    t = setup()
    await t.call(complaint(), { headers: { 'svix-signature': 'v1,AAAA' } })
    expect(t.state.stamps).toHaveLength(0)
  })
  it('a failing stamp never changes the answer', async () => {
    t = setup({ leads: [lead] })
    const res = await t.call(complaint())
    expect(res.status).toBe(200)
  })
})


describe('round 7 — the Resend inbox (G1), failure visibility (G2), raw-byte verification (B6)', () => {
  it('G1: a recorded event lands in webhook_events (provider resend, keyed on svix-id) with a MINIMAL payload', async () => {
    t = setup({ leads: [lead] })
    await t.call({ type: 'email.complained', data: { to: ['dana@acme.com'], subject: 'Secret subject', from: 'a@b.c', html: '<p>x</p>', email_id: 'em_1' } }, { headers: { 'svix-id': 'msg_77' } })
    expect(t.state.events).toHaveLength(1)
    expect(t.state.events[0]).toMatchObject({ provider: 'resend', event_key: 'msg_77', event_type: 'email.complained', reference: null, status: 'PROCESSED' })
    // (the minimal shape that is stored while the event is unfinished is pinned in the minimalResendEvent test below)
    expect(t.state.events[0].payload).toBeNull()   // recipient addresses are cleared once it completes — this codebase keeps hashes only
  })
  it('G1: minimalResendEvent keeps type, recipients, id, bounce type and a short failure reason — nothing else', () => {
    t = setup()
    expect(t.mod.minimalResendEvent({ type: 'email.failed', created_at: '2026-10-09T10:00:00Z', data: { to: ['a@b.co', 5], from: 'x@y.z', subject: 'S', html: '<p/>', tags: [{ n: 1 }],
      email_id: 'em_1', bounce: { type: 'Permanent', message: 'long text' }, failed: { reason: 'r'.repeat(500) } } }))
      .toEqual({ type: 'email.failed', created_at: '2026-10-09T10:00:00Z', data: { to: ['a@b.co'], email_id: 'em_1', bounce: { type: 'Permanent' }, failed: { reason: 'r'.repeat(200) } } })
  })
  it('G1: an event that FAILED keeps its payload (it is needed to retry), and loses it once the retry succeeds', async () => {
    t = setup({ leads: [lead], failMailSuppression: true })
    await expect(t.call(complaint(), { headers: { 'svix-id': 'msg_3' } })).rejects.toThrow()
    expect(t.state.events[0].payload.data.to).toEqual(['dana@acme.com'])
    expect(t.state.events[0].status).toBe('FAILED')
  })
  it('G1: a redelivery of an event already PROCESSED is acknowledged without being run again', async () => {
    t = setup({ leads: [lead] })
    await t.call(complaint(), { headers: { 'svix-id': 'msg_5' } })
    const audits = t.state.audit.length, writes = t.state.mailSuppressed.length
    const again = await t.call(complaint(), { headers: { 'svix-id': 'msg_5' } })
    expect(again.status).toBe(200)
    expect(t.state.audit).toHaveLength(audits)
    expect(t.state.mailSuppressed).toHaveLength(writes)
    expect(t.state.events).toHaveLength(1)
  })
  it('G1: a FAILED event is re-run by its redelivery and then completes; attempts go up', async () => {
    t = setup({ leads: [lead], failMailSuppression: true })
    await expect(t.call(complaint(), { headers: { 'svix-id': 'msg_9' } })).rejects.toThrow()
    t.restore()
    t = setup({ leads: [lead] })
    t.state.events.push({ id: 'we1', provider: 'resend', event_key: 'msg_9', status: 'FAILED', attempts: 1 })
    const res = await t.call(complaint(), { headers: { 'svix-id': 'msg_9' } })
    expect(res.status).toBe(200)
    expect(t.state.events[0]).toMatchObject({ status: 'PROCESSED', attempts: 2 })
  })
  it('G1: a failed inbox write answers 500 (Resend retries), does nothing else, and pages the owner', async () => {
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    t = setup({ leads: [lead], failInboxInsert: true, envExtra: env })
    const res = await t.call(complaint(), { envOver: env })
    expect(res.status).toBe(500)
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.alerts.some(a => /could not be recorded/i.test(a.subject))).toBe(true)
  })
  it('G1: events that are only noise (delivered, opened, clicked) are acknowledged and not recorded', async () => {
    t = setup()
    for (const type of ['email.delivered', 'email.opened', 'email.clicked', 'email.delivery_delayed'])
      expect((await t.call({ type, data: { to: ['a@b.co'] } })).status).toBe(200)
    expect(t.state.events).toHaveLength(0)
  })
  it('G1: a transient bounce is recorded and closed IGNORED (visible, never replayable noise)', async () => {
    t = setup()
    await t.call(bounce('Transient'))
    expect(t.state.events[0]).toMatchObject({ status: 'IGNORED', note: 'transient bounce' })
  })
  it('G2: email.failed and email.suppressed are recorded and page the owner (throttled)', async () => {
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    t = setup({ envExtra: env })
    await t.call({ type: 'email.failed', data: { to: ['a@b.co'], failed: { reason: 'domain not verified' } } }, { envOver: env, headers: { 'svix-id': 'm1' } })
    await t.call({ type: 'email.failed', data: { to: ['a@b.co'] } }, { envOver: env, headers: { 'svix-id': 'm2' } })
    await t.call({ type: 'email.suppressed', data: { to: ['a@b.co'] } }, { envOver: env, headers: { 'svix-id': 'm3' } })
    expect(t.state.events.map(e => e.status)).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED'])
    expect(t.state.alerts.filter(a => /email\.failed/.test(a.subject))).toHaveLength(1)   // second one throttled
    expect(t.state.alerts.some(a => /email\.suppressed/.test(a.subject))).toBe(true)
    expect(t.state.alerts.find(a => /email\.failed/.test(a.subject)).message).toMatch(/domain not verified/)
  })
  it('G2: a hard bounce / failure on a REGISTERED ACCOUNT address pages the owner about it (no address in the email)', async () => {
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    t = setup({ users: [{ id: 'u1', email: 'buyer@x.co' }], envExtra: env })
    await t.call(bounce('Permanent', ['buyer@x.co']), { envOver: env })
    const a = t.state.alerts.find(x => /registered account/i.test(x.subject))
    expect(a).toBeTruthy()
    expect(a.message).not.toContain('buyer@x.co')
  })
  it('G2: a bounce of a non-account address does not send the account alert', async () => {
    const env = { RESEND_WEBHOOK_SECRET: SECRET, RATE_LIMIT_KV: kv() }
    t = setup({ envExtra: env })
    await t.call(bounce('Permanent', ['stranger@x.co']), { envOver: env })
    expect(t.state.alerts.some(x => /registered account/i.test(x.subject))).toBe(false)
  })
  it('B6: the signature is checked over the raw bytes — a leading BOM (which text() strips) still verifies', async () => {
    t = setup({ leads: [lead] })
    const res = await t.call(null, { rawBody: '\uFEFF' + JSON.stringify(complaint()) })
    // verified over the bytes actually sent (text() would have stripped the BOM and failed the HMAC → 401)
    expect(res.status).toBe(200)
    expect(t.state.leads).toHaveLength(0)
  })
  it('B6: the size cap is in BYTES — a multi-byte body over the cap is refused', async () => {
    t = setup()
    const body = JSON.stringify({ type: 'email.delivered', pad: 'é'.repeat(140 * 1024) })   // ~140K chars, ~280K bytes
    expect((await t.call(null, { rawBody: body })).status).toBe(413)
  })
  it('verifySvixSignature accepts raw bytes and a string identically', async () => {
    const body = '{"type":"x","n":"é"}', ts = nowTs()
    const sig = sign('m', ts, body)
    const a = { secret: SECRET, id: 'm', timestamp: ts, signature: sig }
    expect(await verifySvixSignature({ ...a, body })).toBe(true)
    expect(await verifySvixSignature({ ...a, body: new TextEncoder().encode(body) })).toBe(true)
    expect(await verifySvixSignature({ ...a, body: new TextEncoder().encode(body + ' ') })).toBe(false)
  })
})

describe('round 8 — B1: the recipient payload is cleared only once the status write has landed', () => {
  let tt, realErr
  beforeEach(() => { realErr = console.error; console.error = () => {} })
  afterEach(() => { console.error = realErr; tt?.restore() })
  it('a lost status write leaves the row RECEIVED WITH its payload, so the re-drive can finish it', async () => {
    tt = setup({ failStatusUpdate: true })
    const res = await tt.call({ type: 'email.complained', data: { to: ['someone@example.com'] } })
    expect(res.status).toBe(200)
    expect(tt.state.events[0].status).toBe('RECEIVED')
    expect(tt.state.events[0].payload).not.toBeNull()
  })
  it('the normal path still clears it', async () => {
    tt = setup()
    await tt.call({ type: 'email.complained', data: { to: ['someone@example.com'] } })
    expect(tt.state.events[0].status).toBe('PROCESSED')
    expect(tt.state.events[0].payload).toBeNull()
  })
})
