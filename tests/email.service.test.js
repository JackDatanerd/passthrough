import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { render } from '../src/templates/emails.js'

function kv() { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

function setup({ sendFails = false, logInsertError = null } = {}) {
  const sent = []
  const db = createFakeSupabase(q => (q.table === 'email_logs' || q.table === 'alert_logs') && q.op === 'insert'
    ? { data: null, error: logInsertError } : undefined)
  const { mod, restore } = loadWithStubs('services/email.service.js', {
    'config/email.js': { sendViaResend: async (env, msg) => { if (sendFails) throw new Error('Resend down'); sent.push(msg); return { id: 'x' } } },
    'config/supabase.js': { getSupabase: () => db },
  })
  const env = { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <hello@passthrough.dev>', OWNER_ALERT_EMAIL: 'owner@example.com', RATE_LIMIT_KV: kv() }
  return { mod, restore, sent, db, env }
}
const logs = (db, table = 'email_logs') => db.calls.filter(q => q.table === table && q.op === 'insert').map(q => q.values)

let t, realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr; t?.restore() })

describe('email send — per-recipient throttle', () => {
  it('stops mailing one address once a stranger-triggerable template exceeds its hourly limit', async () => {
    t = setup()
    const results = []
    for (let i = 0; i < 4; i++) results.push(await t.mod.sendPasswordReset(t.env, t.db, 'victim@example.com', 'V', 'tok'))
    expect(results).toEqual([true, true, true, false])          // password_reset: 3/hour
    expect(t.sent).toHaveLength(3)
    expect(logs(t.db).map(l => l.status)).toEqual(['sent', 'sent', 'sent', 'throttled'])
  })
  it('is per recipient and case-insensitive', async () => {
    t = setup()
    for (let i = 0; i < 3; i++) await t.mod.sendPasswordReset(t.env, t.db, 'Victim@Example.com', 'V', 't')
    expect(await t.mod.sendPasswordReset(t.env, t.db, 'victim@example.com', 'V', 't')).toBe(false)
    expect(await t.mod.sendPasswordReset(t.env, t.db, 'someone.else@example.com', 'S', 't')).toBe(true)
  })
  it('does NOT throttle transactional mail that follows a real customer action', async () => {
    t = setup()
    for (let i = 0; i < 10; i++) expect(await t.mod.sendFixDeliveredPlain(t.env, t.db, 'a@b.co', 'A')).toBe(true)
  })
  it('the anonymous scan-result email (open to any typed address) is throttled too', async () => {
    t = setup()
    const r = []
    for (let i = 0; i < 4; i++) r.push(await t.mod.sendAnonScanResult(t.env, t.db, 'v@x.co', 'N', 'scan1', 'tok', 50, false))
    expect(r).toEqual([true, true, true, false])
  })
  it('fails open if KV is down — an outage must not stop password-reset mail', async () => {
    t = setup()
    t.env.RATE_LIMIT_KV = { get: async () => { throw new Error('down') }, put: async () => { throw new Error('down') } }
    expect(await t.mod.sendPasswordReset(t.env, t.db, 'a@b.co', 'A', 't')).toBe(true)
  })
})

describe('email send — content', () => {
  it('sends an HTML body AND a plain-text alternative containing the link', async () => {
    t = setup()
    await t.mod.sendVerification(t.env, t.db, 'a@b.co', 'Ada', 'abc123')
    const m = t.sent[0]
    expect(m.html).toContain('href="https://passthrough.dev/verify-email?token=abc123"')
    expect(m.text).toContain('https://passthrough.dev/verify-email?token=abc123')
    expect(m.text).not.toMatch(/<[a-z]/i)
    expect(m.text).not.toContain('{{')
  })
  it('quotes prices from constants.js — the promo price while a promo runs, standard after', async () => {
    t = setup()
    const promo = { ...t.env, PROMO_ACTIVE: 'true', PROMO_ENDS_AT: new Date(Date.now() + 86400000).toISOString() }
    await t.mod.sendScanFail(promo, t.db, 'a@b.co', 'A', 40, {})
    expect(t.sent.at(-1).html).toContain('Fix My Resume — $29')
    await t.mod.sendScanFail(t.env, t.db, 'a@b.co', 'A', 40, {})
    expect(t.sent.at(-1).html).toContain('Fix My Resume — $49')
    expect(t.sent.at(-1).html).toContain('below 75')
    await t.mod.sendScanPass(promo, t.db, 'a@b.co', 'A', 85)
    expect(t.sent.at(-1).html).toContain('Get Verified — $9')
    expect(t.sent.at(-1).html).toContain('Full Package — $29')
  })
  it('no template ever leaves a raw {{PLACEHOLDER}} behind', async () => {
    t = setup()
    await t.mod.sendWelcome(t.env, t.db, 'a@b.co', 'A')
    await t.mod.sendScanFail(t.env, t.db, 'a@b.co', 'A', 40, { keywordScore: 1 })
    await t.mod.sendScanPass(t.env, t.db, 'a@b.co', 'A', 78)
    await t.mod.sendScanPass(t.env, t.db, 'a@b.co', 'A', 90)
    await t.mod.sendPasswordChanged(t.env, t.db, 'a@b.co', 'A')
    await t.mod.sendEmailChangedOldAddress(t.env, t.db, 'old@b.co', 'A', 'new@b.co')
    await t.mod.sendAccountDeleted(t.env, t.db, 'a@b.co', 'A')
    for (const m of t.sent) expect(m.html).not.toMatch(/{{\w+}}/)
    expect(t.sent[0].html).toContain('href="https://passthrough.dev"')      // welcome link follows FRONTEND_URL, not a hard-coded prod URL
  })
  it('a user-supplied display name is escaped, and never re-interpreted as a placeholder', () => {
    const html = render('welcome', { NAME: '<img src=x onerror=1> {{FRONTEND_URL}} $&', FRONTEND_URL: 'https://p.dev' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('{{FRONTEND_URL}} $&amp;')       // literal — not substituted a second time
  })
  it('one variable\'s value cannot smuggle in another placeholder for a later pass to resolve', () => {
    // NAME's own content is the literal text "{{FRONTEND_URL}}" — a single
    // sweep must never treat that as real template syntax to fill in.
    const html = render('welcome', { NAME: '{{FRONTEND_URL}}', FRONTEND_URL: 'https://real.example' })
    expect(html).toContain('Welcome, {{FRONTEND_URL}}!')
    expect(html).not.toContain('Welcome, https://real.example!')
  })
  it('an unsupplied placeholder is left visible rather than silently blanked', () => {
    const html = render('email_changed_old_address', { NAME: 'A' })
    expect(html).toContain('{{NEW_EMAIL}}')
  })
})

describe('security notifications', () => {
  it('a password-change notice goes to the account address', async () => {
    t = setup()
    await t.mod.sendPasswordChanged(t.env, t.db, 'a@b.co', 'Ada')
    expect(t.sent[0].to).toBe('a@b.co')
  })
  it('an email-change notice goes to the PREVIOUS address and names the new one', async () => {
    t = setup()
    await t.mod.sendEmailChangedOldAddress(t.env, t.db, 'old@b.co', 'Ada', 'attacker@evil.co')
    expect(t.sent[0].to).toBe('old@b.co')
    expect(t.sent[0].html).toContain('attacker@evil.co')
  })
})

describe('email_logs / alert_logs', () => {
  it('records a failed send with its error', async () => {
    t = setup({ sendFails: true })
    expect(await t.mod.sendWelcome(t.env, t.db, 'a@b.co', 'A')).toBe(false)
    expect(logs(t.db)[0]).toMatchObject({ status: 'failed', error: 'Resend down', template: 'welcome' })
  })
  it('a failing email_logs INSERT (returned as {error}, never thrown by supabase-js) is detected and logged, not swallowed silently', async () => {
    t = setup({ logInsertError: new Error('relation "email_logs" does not exist') })
    const lines = []; console.error = (...a) => lines.push(a.join(' '))
    expect(await t.mod.sendWelcome(t.env, t.db, 'a@b.co', 'A')).toBe(true)      // the email itself still went
    expect(lines.join('\n')).toContain('email_logs insert failed')
  })
})

describe('sendOwnerAlert — de-duplicated', () => {
  it('emails the same alert once per window but records every occurrence', async () => {
    t = setup()
    const a = await t.mod.sendOwnerAlert(t.env, 'Queue job failed: generateFix', 'scan 1')
    const b = await t.mod.sendOwnerAlert(t.env, 'Queue job failed: generateFix', 'scan 2')
    const c = await t.mod.sendOwnerAlert(t.env, 'A different alert', 'x')
    expect([a, b, c]).toEqual([true, false, true])
    expect(t.sent).toHaveLength(2)
    const rows = logs(t.db, 'alert_logs')
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.emailed)).toEqual([true, false, true])
  })
  it('still writes alert_logs when there is no owner address', async () => {
    t = setup(); delete t.env.OWNER_ALERT_EMAIL
    expect(await t.mod.sendOwnerAlert(t.env, 's', 'm')).toBe(false)
    expect(logs(t.db, 'alert_logs')).toHaveLength(1)
  })
})

describe('htmlToPlainText / fmtMoney', () => {
  it('converts links, paragraphs, entities; drops <style>', () => {
    t = setup()
    const txt = t.mod.htmlToPlainText('<style>.a{}</style><h2>Hi &amp; welcome</h2><p>Click <a href="https://x.co/?a=1&amp;b=2" class="btn">Verify \u2192</a></p><p>Bye</p>')
    expect(txt).toBe('Hi & welcome\nClick Verify \u2192 (https://x.co/?a=1&b=2)\nBye')
  })
  it('a link whose label IS the url is not duplicated', () => {
    t = setup()
    expect(t.mod.htmlToPlainText('<a href="https://x.co">https://x.co</a>')).toBe('https://x.co')
  })
  it('formats money', () => {
    t = setup()
    expect(t.mod.fmtMoney(4900, 'USD')).toBe('$49')
    expect(t.mod.fmtMoney(950, 'USD')).toBe('$9.50')
    expect(t.mod.fmtMoney(4900, 'KES')).toBe('49 KES')
  })
})
