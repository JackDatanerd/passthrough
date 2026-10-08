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

function setup({ leads = [], suppressed = [], envExtra = {} } = {}) {
  const state = { leads: leads.map(l => ({ ...l })), suppressed: new Set(suppressed), audit: [], logPurges: [] }
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
    if (q.table === 'email_logs') { state.logPurges.push(Object.fromEntries(q.filters.map(f => [f[1], f[2]]))); return { data: null, error: null } }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
    return undefined
  })
  // The real performRemoval is used (it lives in the leads controller); only Supabase is faked.
  const { mod, restore } = loadWithStubs('controllers/resend-webhook.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  const env = { RESEND_WEBHOOK_SECRET: SECRET, ...envExtra }
  const call = async (event, { headers, rawBody, envOver } = {}) => {
    const body = rawBody ?? JSON.stringify(event)
    const ts = nowTs()
    const h = { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': sign('msg_1', ts, body), ...headers }
    const c = {
      env: envOver || env,
      get: () => undefined,
      req: { header: k => h[k.toLowerCase()], text: async () => body },
      text: (t, status = 200) => ({ text: t, status }),
      json: (b, status = 200) => ({ body: b, status }),
    }
    return mod.handleResend(c)
  }
  return { mod, restore, state, call }
}

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

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
  it('a complaint suppresses even an address that is not a lead (so a later form submit is ignored)', async () => {
    t = setup({ leads: [] })
    await t.call(complaint(['Someone <Someone@Elsewhere.com>']))
    expect(t.state.suppressed.size).toBe(1)
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

describe('normalizeRecipient', () => {
  it('extracts and lowercases addresses', () => {
    t = setup()
    const { normalizeRecipient } = t.mod
    expect(normalizeRecipient('Dana <Dana@Acme.com>')).toBe('dana@acme.com')
    expect(normalizeRecipient(' a@b.co ')).toBe('a@b.co')
    for (const v of ['', 'nope', 'a@b', 'a b@c.com', null, 5]) expect(normalizeRecipient(v)).toBeNull()
  })
})
