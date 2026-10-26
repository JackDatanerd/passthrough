import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// SUPPORT-INBOXES ROUND 1: the Resend webhook turns `inbox.thread.created` (the first email of a new conversation in a Resend
// Inbox) into one notice to the owner's Gmail, and pages the owner when a reply sent FROM the support address does not arrive.

const KEY = Buffer.from('a-test-signing-key-of-some-length')
const SECRET = 'whsec_' + KEY.toString('base64')
const sign = (id, ts, body) => 'v1,' + createHmac('sha256', KEY).update(`${id}.${ts}.${body}`).digest('base64')
const nowTs = () => String(Math.floor(Date.now() / 1000))
const kv = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

const THREAD = '79f3372f-703d-4e76-8228-9c8b3db5ec00'
const thread = (emailOver = {}, dataOver = {}) => ({
  type: 'inbox.thread.created', created_at: '2026-10-26T09:50:00.000Z',
  data: {
    source: 'system', inbox_id: 'ib1', thread_id: THREAD, email_id: 'em1',
    thread: { object: 'inbox_thread', id: THREAD, subject: 'Test', folder: 'inbox', labels: [], read: false },
    email: {
      id: 'em1', direction: 'inbound', from: 'Cory Angelini <coryangelini0@gmail.com>', to: ['support@usepassthrough.com'], cc: [], bcc: [],
      reply_to: [], subject: 'Test', message_id: '<abc@mail.gmail.com>', attachments: [], read: false, received_at: '2026-10-26T09:50:00.000Z', ...emailOver
    },
    ...dataOver
  }
})

function setup({ envExtra = {}, failNotice = false } = {}) {
  const state = { events: [], inserted: [], stamps: [], alerts: [], notices: [], failNotice, mailSuppressed: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'webhook_events') {
      if (q.op === 'insert') {
        if (state.events.some(e => e.provider === q.values.provider && e.event_key === q.values.event_key)) return { data: null, error: { code: '23505', message: 'duplicate' } }
        const row = { id: 'we' + (state.events.length + 1), status: 'RECEIVED', attempts: 1, ...q.values }
        state.events.push(row); state.inserted.push(JSON.parse(JSON.stringify(q.values)))
        return { data: { id: row.id, attempts: 1 }, error: null }
      }
      if (q.op === 'update') { const id = q.filters.find(f => f[1] === 'id')?.[2]; const row = state.events.find(e => e.id === id); if (row) Object.assign(row, q.patch); return { data: null, error: null } }
      const key = q.filters.find(f => f[1] === 'event_key')?.[2]; const row = state.events.find(e => e.event_key === key)
      return { data: row ? { id: row.id, status: row.status, attempts: row.attempts } : null, error: null }
    }
    if (q.table === 'system_state') { if (q.op === 'upsert') state.stamps.push(q.values); return { data: null, error: null } }
    if (q.table === 'email_suppressions') { if (q.op === 'upsert') state.mailSuppressed.push(q.values); return { data: null, error: null } }
    if (q.table === 'employer_leads') return { data: null, error: null }
    if (q.table === 'users') return q.op === 'update' ? { data: [], error: null } : (q.maybe ? { data: null, error: null } : { data: [], error: null })
    if (q.table === 'email_logs') return { data: [], error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/resend-webhook.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async (env, subject, message) => { state.alerts.push({ subject, message }); return true },
      sendSupportInboxNotice: async (env, subject, message, opts) => {
        if (state.failNotice) throw new Error('Resend down')
        if (!env.OWNER_ALERT_EMAIL) return false
        state.notices.push({ subject, message, opts }); return true
      }
    },
  })
  const env = { RESEND_WEBHOOK_SECRET: SECRET, EMAIL_FROM: 'Passthrough <hello@usepassthrough.com>', OWNER_ALERT_EMAIL: 'owner@example.com', RATE_LIMIT_KV: kv(), ...envExtra }
  let seq = 0
  const call = async (event, { id } = {}) => {
    const body = JSON.stringify(event); const ts = nowTs(); const svixId = id || `msg_${++seq}`
    const h = { 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': sign(svixId, ts, body) }
    const pending = []
    const c = {
      env, executionCtx: { waitUntil: p => pending.push(p) }, get: () => undefined,
      req: { header: k => h[k.toLowerCase()], text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer },
      text: (t, status = 200) => ({ text: t, status }), json: (b, status = 200) => ({ body: b, status }),
    }
    const res = await mod.handleResend(c)
    await Promise.all(pending)
    return res
  }
  return { mod, restore, state, call, env, db }
}

let t, realErr, realWarn
beforeEach(() => { realErr = console.error; realWarn = console.warn; console.error = () => {}; console.warn = () => {} })
afterEach(() => { console.error = realErr; console.warn = realWarn; t?.restore() })

describe('inbox.thread.created → owner notice', () => {
  it('mails the owner once for a new inbound conversation, with sender, subject, inbox and a thread link', async () => {
    t = setup()
    const res = await t.call(thread())
    expect(res.status).toBe(200)
    expect(t.state.notices).toHaveLength(1)
    const n = t.state.notices[0]
    expect(n.subject).toBe('Test')
    expect(n.message).toContain('Cory Angelini <coryangelini0@gmail.com>')
    expect(n.message).toContain('support@usepassthrough.com')
    expect(n.message).toContain(`https://resend.com/inboxes/support@usepassthrough.com/${THREAD}`)
    expect(n.message).toContain('Attachments: 0')
    // a redelivery after a send that DID succeed can never send twice: the key comes from the thread
    expect(n.opts.idempotencyKey).toBe(`support-thread/${THREAD}`)
  })
  it('records the event, keeps only what the notice needs while unfinished, and clears it once done', async () => {
    t = setup()
    await t.call(thread({ attachments: [{ id: 'a1', filename: 'cv-dana.pdf', size: 10 }], html: '<p>secret body</p>', text: 'secret body' }))
    const inserted = t.state.inserted[0]
    expect(inserted).toMatchObject({ provider: 'resend', event_type: 'inbox.thread.created' })
    expect(inserted.payload.data.email).toMatchObject({ direction: 'inbound', subject: 'Test', attachments: 1 })
    expect(JSON.stringify(inserted.payload)).not.toMatch(/secret body|cv-dana/)
    expect(t.state.events[0]).toMatchObject({ status: 'PROCESSED', note: 'new thread — owner notified', payload: null })
  })
  it('stamps the support-inbox proof of life (and the general Resend one)', async () => {
    t = setup()
    await t.call(thread())
    expect(t.state.stamps.some(s => s.key === 'support_inbox' && s.value.last_thread_at)).toBe(true)
    expect(t.state.stamps.some(s => s.key === 'resend_webhook')).toBe(true)
  })
  it('answers 200 without a second notice when Resend redelivers an event that already finished', async () => {
    t = setup()
    await t.call(thread(), { id: 'same' })
    const again = await t.call(thread(), { id: 'same' })
    expect(again.status).toBe(200)
    expect(t.state.notices).toHaveLength(1)
  })
  it('does not announce a thread YOU started (outbound), and does not even stamp it', async () => {
    t = setup()
    await t.call(thread({ direction: 'outbound', from: 'support@usepassthrough.com', to: ['cust@example.com'] }))
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.events[0]).toMatchObject({ status: 'IGNORED', note: 'not an inbound thread' })
    expect(t.state.stamps.some(s => s.key === 'support_inbox')).toBe(false)
  })
  it('ignores mail from our own mailboxes (a support@ → hello@ loop)', async () => {
    t = setup()
    await t.call(thread({ from: 'Passthrough Support <SUPPORT@usepassthrough.com>' }))
    await t.call(thread({ from: 'Passthrough <hello@usepassthrough.com>' }, { thread_id: THREAD.replace('00', '01') }))
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.events.map(e => e.note)).toEqual(['sent from our own mailbox', 'sent from our own mailbox'])
  })
  it('ignores machines — mailer-daemon, no-reply, out-of-office — but not a real person whose name merely starts that way', async () => {
    t = setup()
    const machines = [
      { from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }, { from: 'noreply@service.com' }, { from: 'no-reply+abc@service.com' },
      { from: 'bounces@lists.example.com' }, { from: 'postmaster@example.com' },
      { from: 'Dana <dana@acme.com>', subject: 'Automatic reply: your receipt' }, { from: 'Dana <dana@acme.com>', subject: 'Out of Office until Monday' },
      { from: 'Dana <dana@acme.com>', subject: 'Undeliverable: hello' },
    ]
    for (const m of machines) await t.call(thread(m))
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.events.every(e => e.note === 'automated message')).toBe(true)
    await t.call(thread({ from: 'noreplyfan@gmail.com', subject: 'Question about my invoice' }))
    expect(t.state.notices).toHaveLength(1)
  })
  it('caps notices at 3 per sender per hour — other senders are unaffected, the thread stays in the Inbox', async () => {
    t = setup()
    for (let i = 0; i < 4; i++) await t.call(thread({ subject: `s${i}` }))
    await t.call(thread({ from: 'Someone Else <else@example.com>', subject: 'other' }))
    expect(t.state.notices.map(n => n.subject)).toEqual(['s0', 's1', 's2', 'other'])
    expect(t.state.events[3]).toMatchObject({ status: 'IGNORED', note: expect.stringMatching(/per-sender notice limit/) })
  })
  it('caps notices at 30 per hour overall and pages the owner ONCE when the cap is hit', async () => {
    t = setup()
    for (let i = 0; i < 33; i++) await t.call(thread({ from: `p${i}@example.com`, subject: `m${i}` }))
    expect(t.state.notices).toHaveLength(30)
    const flood = t.state.alerts.filter(a => /notices paused/i.test(a.subject))
    expect(flood).toHaveLength(1)
    expect(flood[0].message).toMatch(/resend\.com\/inboxes/)
    expect(JSON.stringify(flood)).not.toMatch(/@example\.com/)       // alert_logs keeps no customer addresses
  })
  it('a failed send answers 500-by-throw, hands the caps back, and the retry then succeeds exactly once', async () => {
    t = setup({ failNotice: true })
    await expect(t.call(thread(), { id: 'retry-me' })).rejects.toThrow(/Resend down/)
    expect(t.state.events[0]).toMatchObject({ status: 'FAILED' })
    expect(t.state.events[0].payload).not.toBeNull()                    // kept so the hourly re-drive can re-run it
    t.state.failNotice = false
    const res = await t.call(thread(), { id: 'retry-me' })
    expect(res.status).toBe(200)
    expect(t.state.notices).toHaveLength(1)
    // the failed attempt did not eat the sender's allowance: two more threads still get through (3 in all), the fourth does not
    await t.call(thread({ subject: 'b' })); await t.call(thread({ subject: 'c' })); await t.call(thread({ subject: 'd' }))
    expect(t.state.notices.map(n => n.subject)).toEqual(['Test', 'b', 'c'])
  })
  it('the admin replay / hourly re-drive runs the stored minimal payload through the same handler', async () => {
    t = setup()
    const minimal = t.mod.minimalResendEvent(thread({ attachments: [{ id: 'a' }, { id: 'b' }] }), t.env)
    const c = { env: t.env, executionCtx: { waitUntil() {} } }
    const outcome = await t.mod.processResendEvent(c, t.db, JSON.parse(JSON.stringify(minimal)))
    expect(outcome).toMatchObject({ status: 'PROCESSED' })
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.notices[0].message).toContain('Attachments: 2')
  })
  it('says so loudly (and does not pretend) when OWNER_ALERT_EMAIL is not set', async () => {
    t = setup({ envExtra: { OWNER_ALERT_EMAIL: undefined } })
    const res = await t.call(thread())
    expect(res.status).toBe(200)
    expect(t.state.events[0]).toMatchObject({ status: 'PROCESSED', note: 'OWNER_ALERT_EMAIL not set — owner NOT notified' })
  })
  it('a hostile subject cannot inject headers or run on: control characters are flattened and the length capped', async () => {
    t = setup()
    await t.call(thread({ subject: 'Hi\r\nBcc: attacker@evil.com\u0000' + 'x'.repeat(500) }))
    const n = t.state.notices[0]
    expect(n.subject).not.toMatch(/[\r\n\u0000]/)
    expect(n.subject.length).toBeLessThanOrEqual(200)
  })
  it('a thread with no usable thread id still notifies, links to the inbox, and carries no idempotency key', async () => {
    t = setup()
    await t.call(thread({}, { thread_id: 'not a valid id!', email_id: undefined }))
    expect(t.state.notices[0].message).toContain('https://resend.com/inboxes/support@usepassthrough.com\n')
    expect(t.state.notices[0].opts.idempotencyKey).toBe('support-thread/not a valid id!')
  })
  it('SUPPORT_EMAIL decides which inbox the link points at when the mail was addressed elsewhere', async () => {
    t = setup({ envExtra: { SUPPORT_EMAIL: 'help@usepassthrough.com' } })
    await t.call(thread({ to: ['someone-else@gmail.com'] }))
    expect(t.state.notices[0].message).toContain(`https://resend.com/inboxes/help@usepassthrough.com/${THREAD}`)
  })
})

describe('a reply sent FROM the support address that does not arrive', () => {
  const bounced = (over = {}, type = 'email.bounced') => ({ type, data: { email_id: 'em9', from: 'Passthrough Support <support@usepassthrough.com>', to: ['cust@elsewhere.com'], bounce: { type: 'Permanent' }, ...over } })

  it('pages the owner, naming the Resend email id but not the customer’s address', async () => {
    t = setup()
    await t.call(bounced())
    const a = t.state.alerts.filter(x => /reply sent from the support address/i.test(x.subject))
    expect(a).toHaveLength(1)
    expect(a[0].message).toContain('em9')
    expect(a[0].message).toContain('support@usepassthrough.com')
    expect(JSON.stringify(a)).not.toContain('cust@elsewhere.com')
  })
  it('also pages for a spam complaint and a failed send on a support reply', async () => {
    t = setup()
    await t.call(bounced({ email_id: 'em10' }, 'email.complained'))
    await t.call(bounced({ email_id: 'em11', failed: { reason: 'x' } }, 'email.failed'))
    expect(t.state.alerts.filter(x => /reply sent from the support address/i.test(x.subject))).toHaveLength(2)
  })
  it('does NOT page for a transient bounce, or for ordinary app mail sent from the hello@ sender', async () => {
    t = setup()
    await t.call(bounced({ bounce: { type: 'Transient' } }))
    await t.call(bounced({ from: 'Passthrough <hello@usepassthrough.com>', email_id: 'em12' }))
    expect(t.state.alerts.filter(x => /reply sent from the support address/i.test(x.subject))).toHaveLength(0)
  })
  it('still recognises the support address after the payload is stored minimal (re-drive)', async () => {
    t = setup()
    const minimal = t.mod.minimalResendEvent(bounced(), t.env)
    expect(minimal.data.from).toBe('support@usepassthrough.com')
    const app = t.mod.minimalResendEvent(bounced({ from: 'Some Customer <cust@elsewhere.com>' }), t.env)
    expect('from' in app.data).toBe(false)               // a customer's address is never kept
  })
  it('does nothing special when SUPPORT_EMAIL is the very address mail is sent from (cannot tell the two apart)', async () => {
    t = setup({ envExtra: { SUPPORT_EMAIL: 'hello@usepassthrough.com' } })
    await t.call(bounced({ from: 'hello@usepassthrough.com' }))
    expect(t.state.alerts.filter(x => /reply sent from the support address/i.test(x.subject))).toHaveLength(0)
  })
})
