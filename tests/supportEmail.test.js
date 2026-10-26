import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { bareAddress, supportEmail, fromAddress, replyToFor, ownMailboxes, DEFAULT_SUPPORT_EMAIL } from '../src/lib/supportEmail.js'

// SUPPORT-INBOXES ROUND 1: one source for the support address, Reply-To on customer mail, and the owner notice.

const root = fileURLToPath(new URL('..', import.meta.url))
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist') continue
    const p = join(dir, f)
    statSync(p).isDirectory() ? walk(p, out) : out.push(p)
  }
  return out
}

describe('lib/supportEmail', () => {
  it('bareAddress takes the address out of a display-name form, lowercases it, and refuses anything else', () => {
    expect(bareAddress('Dana Whitfield <Dana@Acme.com>')).toBe('dana@acme.com')
    expect(bareAddress('  support@usepassthrough.com ')).toBe('support@usepassthrough.com')
    for (const bad of [undefined, null, 42, '', 'no-at-sign', 'a@b', 'a b@c.com', 'a@b.com, c@d.com', '<>', 'x'.repeat(260) + '@a.com']) expect(bareAddress(bad)).toBeNull()
  })
  it('supportEmail uses SUPPORT_EMAIL when valid and the default when blank, missing or malformed', () => {
    expect(supportEmail({ SUPPORT_EMAIL: 'Help@Example.com' })).toBe('help@example.com')
    for (const env of [undefined, {}, { SUPPORT_EMAIL: '' }, { SUPPORT_EMAIL: 'not an address' }, { SUPPORT_EMAIL: 'a@b.com, c@d.com' }]) expect(supportEmail(env)).toBe(DEFAULT_SUPPORT_EMAIL)
    expect(DEFAULT_SUPPORT_EMAIL).toBe('support@usepassthrough.com')
  })
  it('replyToFor is the support address, except when that is the very address mail is sent from', () => {
    expect(replyToFor({ EMAIL_FROM: 'Passthrough <hello@usepassthrough.com>' })).toBe('support@usepassthrough.com')
    expect(replyToFor({ EMAIL_FROM: 'Passthrough <support@usepassthrough.com>' })).toBeUndefined()
    expect(replyToFor({ EMAIL_FROM: 'Passthrough <hello@usepassthrough.com>', SUPPORT_EMAIL: 'help@usepassthrough.com' })).toBe('help@usepassthrough.com')
    expect(fromAddress({ EMAIL_FROM: 'garbage' })).toBeNull()
  })
  it('ownMailboxes holds the support address and the sender address', () => {
    expect([...ownMailboxes({ EMAIL_FROM: 'P <hello@usepassthrough.com>' })].sort()).toEqual(['hello@usepassthrough.com', 'support@usepassthrough.com'])
  })
})

describe('the support address is typed in exactly one place per side', () => {
  const literal = /support@usepassthrough\.com/
  it('server: nothing under src/ hardcodes it except lib/supportEmail.js', () => {
    const offenders = walk(join(root, 'src')).filter(f => /\.(js|cjs|mjs)$/.test(f) && literal.test(readFileSync(f, 'utf8'))).map(f => relative(root, f))
    expect(offenders).toEqual(['src/lib/supportEmail.js'])
  })
  it('frontend: nothing under frontend/src hardcodes it except lib/support.js', () => {
    const offenders = walk(join(root, 'frontend', 'src')).filter(f => /\.(js|jsx)$/.test(f) && literal.test(readFileSync(f, 'utf8'))).map(f => relative(root, f).replace(/\\/g, '/'))
    expect(offenders).toEqual(['frontend/src/lib/support.js'])
  })
})

// ── the sender, through the real templates ────────────────────────────────────────────────────────────────────────
let t
afterEach(() => t?.restore())
function setupSvc({ failSend = false } = {}) {
  const sent = [], logs = [], alertRows = []
  t = loadWithStubs('services/email.service.js', {
    'config/email.js': { sendViaResend: async (env, m) => { if (failSend) throw new Error('Resend down'); sent.push(m); return { id: '1' } } },
    'middleware/rateLimiter.js': { hitQuota: async () => true, refundQuota: async () => {} },
  })
  const db = { from: table => ({ insert: async row => { (table === 'alert_logs' ? alertRows : logs).push(row); return { error: null } } }) }
  const env = { FRONTEND_URL: 'https://usepassthrough.com', EMAIL_FROM: 'Passthrough <hello@usepassthrough.com>', OWNER_ALERT_EMAIL: 'owner@example.com', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: {} }
  return { svc: t.mod, sent, logs, alertRows, db, env }
}

describe('customer mail carries Reply-To: the support mailbox', () => {
  it('sets Reply-To to the support address on ordinary customer mail', async () => {
    const s = setupSvc()
    await s.svc.sendPasswordReset(s.env, s.db, 'u@x.y', 'Ann', 'tok')
    expect(s.sent[0]).toMatchObject({ from: 'Passthrough <hello@usepassthrough.com>', to: 'u@x.y', replyTo: 'support@usepassthrough.com' })
  })
  it('follows SUPPORT_EMAIL, in the header AND in every place the templates print the address', async () => {
    const s = setupSvc(); s.env.SUPPORT_EMAIL = 'help@usepassthrough.com'
    await s.svc.sendEmailChangeCompleted(s.env, s.db, 'u@x.y', 'Ann', 'n@x.y')
    await s.svc.sendEmployerLeadAck(s.env, s.db, 'l@x.y', 'Lee', 'Design', { confirmUrl: 'https://c', removeUrl: 'https://r', prefsUrl: 'https://p' })
    await s.svc.sendPaymentReceipt(s.env, s.db, 'u@x.y', 'Ann', { fixTier: 'FIX', amountCents: 4900, currency: 'USD', reference: 'ref1', createdAt: '2026-10-05T23:30:00Z' })
    expect(s.sent).toHaveLength(3)
    for (const m of s.sent) {
      expect(m.replyTo).toBe('help@usepassthrough.com')
      expect(m.html).not.toContain('support@usepassthrough.com')
      expect(m.text).not.toContain('support@usepassthrough.com')
    }
    expect(s.sent[0].html).toContain('help@usepassthrough.com')
  })
  it('every template that mentions the address renders it from the one variable — none is left as a literal or an unfilled placeholder', async () => {
    const s = setupSvc(); s.env.SUPPORT_EMAIL = 'help@usepassthrough.com'
    const src = readFileSync(join(root, 'src', 'templates', 'emails.js'), 'utf8')
    expect(src).not.toMatch(/support@usepassthrough\.com/)
    expect((src.match(/\{\{SUPPORT_EMAIL\}\}/g) || []).length).toBeGreaterThanOrEqual(19)
    const { render } = await import('../src/templates/emails.js')
    const keys = [...src.matchAll(/^  (\w+): "/gm)].map(m => m[1])
    expect(keys.length).toBeGreaterThan(30)
    let mentioning = 0
    for (const key of keys) {
      const html = render(key, { SUPPORT_EMAIL: 'help@usepassthrough.com' })
      expect(html).not.toContain('{{SUPPORT_EMAIL}}')
      expect(html).not.toContain('support@usepassthrough.com')
      if (html.includes('help@usepassthrough.com')) mentioning++
    }
    expect(mentioning).toBeGreaterThanOrEqual(12)
  })
  it('ignores a malformed SUPPORT_EMAIL (default address in header and body)', async () => {
    const s = setupSvc(); s.env.SUPPORT_EMAIL = 'not an address'
    await s.svc.sendEmailChangeCompleted(s.env, s.db, 'u@x.y', 'Ann', 'n@x.y')
    expect(s.sent[0].replyTo).toBe('support@usepassthrough.com')
    expect(s.sent[0].html).toContain('support@usepassthrough.com')
  })
  it('omits Reply-To when the support address is the sender itself', async () => {
    const s = setupSvc(); s.env.EMAIL_FROM = 'Passthrough <support@usepassthrough.com>'
    await s.svc.sendPasswordReset(s.env, s.db, 'u@x.y', 'Ann', 'tok')
    expect(s.sent[0].replyTo).toBeUndefined()
  })
  it('owner alerts and notices are not customer mail: no Reply-To', async () => {
    const s = setupSvc()
    await s.svc.sendOwnerAlert(s.env, 'Something broke', 'details')
    await s.svc.sendOwnerNotice(s.env, 'A lead', 'details')
    const ownerMails = s.sent.filter(m => m.to === 'owner@example.com')
    expect(ownerMails).toHaveLength(2)
    for (const m of ownerMails) expect(m.replyTo).toBeUndefined()
  })
})

describe('sendSupportInboxNotice', () => {
  it('mails OWNER_ALERT_EMAIL with the [Passthrough Support] prefix, HTML-escaped, with a text part and the pinned idempotency key', async () => {
    const s = setupSvc()
    const ok = await s.svc.sendSupportInboxNotice(s.env, 'Invoice <b>help</b>', 'From: A <a@b.co>\nlink', { idempotencyKey: 'support-thread/t1' })
    expect(ok).toBe(true)
    expect(s.sent[0]).toMatchObject({ to: 'owner@example.com', subject: '[Passthrough Support] Invoice <b>help</b>', idempotencyKey: 'support-thread/t1', text: 'From: A <a@b.co>\nlink' })
    expect(s.sent[0].html).toContain('From: A &lt;a@b.co&gt;')
    expect(s.sent[0].html).not.toContain('<a@b.co>')
  })
  it('writes nothing to alert_logs or email_logs (customer correspondence is not kept in the alert trail)', async () => {
    const s = setupSvc()
    await s.svc.sendSupportInboxNotice(s.env, 'Hi', 'From: a@b.co')
    expect(s.alertRows).toHaveLength(0)
    expect(s.logs).toHaveLength(0)
  })
  it('returns false when OWNER_ALERT_EMAIL is unset, and THROWS when the send fails (so the webhook retries)', async () => {
    const s = setupSvc(); delete s.env.OWNER_ALERT_EMAIL
    const warn = console.warn; console.warn = () => {}
    try { expect(await s.svc.sendSupportInboxNotice(s.env, 'Hi', 'x')).toBe(false) } finally { console.warn = warn }
    t.restore()
    const f = setupSvc({ failSend: true })
    await expect(f.svc.sendSupportInboxNotice(f.env, 'Hi', 'x')).rejects.toThrow('Resend down')
  })
})
