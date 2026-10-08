import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// email.service.js is covered elsewhere with the templates stubbed out — which is exactly how
// `partner_link_regenerated` (used by sendPartnerLinkRegenerated, defined nowhere) went unnoticed:
// the send threw "Unknown email template", a caller's .catch(() => false) swallowed it, and the
// partner never received their new payout link. These tests run every sender through the REAL
// templates.
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

let t
afterEach(() => t?.restore())
function setup({ failSend, renderThrows } = {}) {
  const sent = [], refunds = [], logs = []
  t = loadWithStubs('services/email.service.js', {
    'config/email.js': { sendViaResend: async (env, m) => { if (failSend) throw new Error(failSend); sent.push(m); return { id: '1' } } },
    'middleware/rateLimiter.js': { hitQuota: async () => true, refundQuota: async (...a) => { refunds.push(a) } },
    ...(renderThrows ? { 'templates/emails.js': { render: () => { throw new Error(renderThrows) } } } : {}),
  })
  const db = { from: () => ({ insert: async row => { logs.push(row); return { error: null } } }) }
  const env = { FRONTEND_URL: 'https://passthrough.dev', EMAIL_FROM: 'P <hello@passthrough.dev>', OWNER_ALERT_EMAIL: 'o@x.y', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: {} }
  return { svc: t.mod, sent, refunds, logs, db, env }
}

const CALLS = {
  sendWelcome: ['u@x.y', 'Ann'], sendVerification: ['u@x.y', 'Ann', 'tok'], sendPasswordReset: ['u@x.y', 'Ann', 'tok'],
  sendPasswordChanged: ['u@x.y', 'Ann'], sendEmailChangedOldAddress: ['u@x.y', 'Ann', 'n@x.y'], sendEmailChangeCompleted: ['u@x.y', 'Ann', 'n@x.y'],
  sendEmailChangeConfirmation: ['n@x.y', 'Ann', 'tok'], sendAccountDeleted: ['u@x.y', 'Ann'], sendAccountLockoutAlert: ['u@x.y', 'Ann', 15],
  sendNewSignInAlert: ['u@x.y', 'Ann', { ip: '1.2.3.4', when: Date.UTC(2026, 9, 5, 23, 30) }],
  sendScanFail: ['u@x.y', 'Ann', 60, { keywordScore: 1, formatScore: 2, sectionsScore: 3, contentScore: 4 }], sendScanPass: ['u@x.y', 'Ann', 85],
  sendAnonScanResult: ['u@x.y', 'Ann', 'sid', 'tok', 85, true], sendFixDelivered: ['u@x.y', 'Ann', 'ABC', 'https://v', true],
  sendFixDeliveredPlain: ['u@x.y', 'Ann'], sendFixFailed: ['u@x.y', 'Ann'],
  sendPaymentReceipt: ['u@x.y', 'Ann', { fixTier: 'FIX', amountCents: 4900, currency: 'USD', reference: 'ref1', createdAt: '2026-10-05T23:30:00Z' }],
  sendPaymentReversed: ['u@x.y', 'Ann', { amountCents: 4900, currency: 'USD', reference: 'ref1', reason: 'REFUND', verificationRevoked: true }],
  sendPartnerPayoutDetailsRequest: ['p@x.y', 'P', 'https://u'], sendPayoutSent: ['p@x.y', 'P', 1000, 'USD'], sendReferralCodeCreated: ['p@x.y', 'P', 'CODE', 'https://d'],
  sendPayoutDetailsChanged: ['p@x.y', 'P', 'BANK'], sendPartnerLinkRegenerated: ['p@x.y', 'P', 'https://u'], sendPartnerEmailChanged: ['p@x.y', 'P', 'o@x.y', 'n@x.y'],
  sendPartnerConversionEarned: ['p@x.y', 'P', 'CODE', 500, 'USD', 'https://d'], sendPartnerStatusChanged: ['p@x.y', 'P', 'PAUSED'], sendPartnerApplicationRejected: ['p@x.y', 'P', 'Not a fit yet.'],
  sendPartnerRateChanged: ['p@x.y', 'P', 0.2, 0.25], sendPartnerCommissionReversed: ['p@x.y', 'P', 500, 'USD', 'https://d'],
  sendEmployerLeadAck: ['l@x.y', 'Lee', 'Design', { confirmUrl: 'https://c', removeUrl: 'https://r', unsubscribeUrl: 'https://u' }],
  sendEmployerCandidatesAvailable: ['l@x.y', 'Lee', 'Design', 3, { removeUrl: 'https://r', unsubscribeUrl: 'https://u' }],
}

describe('email templates — every sender renders through the real templates', () => {
  it('every exported send* function is covered by this table', () => {
    const { svc } = setup()
    const senders = Object.keys(svc).filter(k => /^send[A-Z]/.test(k) && !['sendOwnerAlert', 'sendOwnerNotice'].includes(k))
    expect(senders.filter(k => !(k in CALLS))).toEqual([])
  })

  for (const [fn, args] of Object.entries(CALLS)) {
    it(`${fn}: sends, with no unresolved {{placeholder}} in the html or the plain-text part`, async () => {
      const { svc, sent, logs, db, env } = setup()
      const ok = await svc[fn](env, db, ...args)
      expect(ok, `${fn} did not send (logged: ${JSON.stringify(logs[0])})`).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].html).not.toMatch(/{{\w+}}/)
      expect(sent[0].text).not.toMatch(/{{\w+}}/)
      expect(logs[0].status).toBe('sent')
    })
  }

  it('every template name used by send() exists in templates/emails.js (static check)', () => {
    const service = read('../src/services/email.service.js')
    const templates = read('../src/templates/emails.js')
    const used = [...service.matchAll(/send\(\s*env,\s*supabase,\s*[^,]+,\s*(?:'[^']*'|`[^`]*`|"[^"]*"),\s*'([a-z_]+)'/g)].map(m => m[1])
    expect(used.length).toBeGreaterThan(20)
    for (const name of new Set(used)) expect(templates, `template ${name}`).toMatch(new RegExp(`^\\s+${name}:\\s*"`, 'm'))
  })
})

describe('send() failure handling', () => {
  it('a render failure is LOGGED as failed and gives the throttle slot back, instead of escaping', async () => {
    const { svc, sent, logs, refunds, db, env } = setup({ renderThrows: 'Unknown email template: nope' })
    const ok = await svc.sendEmployerLeadAck(env, db, 'l@x.y', 'Lee', 'Design', { confirmUrl: 'a', removeUrl: 'b', unsubscribeUrl: 'c' })
    expect(ok).toBe(false)
    expect(sent).toHaveLength(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'failed', error: 'Unknown email template: nope' })
    expect(refunds.length).toBe(1)
  })

  it('a Resend failure is logged as failed and refunds the slot', async () => {
    const { svc, logs, refunds, db, env } = setup({ failSend: 'Resend down' })
    expect(await svc.sendEmployerLeadAck(env, db, 'l@x.y', 'Lee', 'Design', { confirmUrl: 'a', removeUrl: 'b', unsubscribeUrl: 'c' })).toBe(false)
    expect(logs[0]).toMatchObject({ status: 'failed', error: 'Resend down' })
    expect(refunds).toHaveLength(1)
  })
})

describe('timestamps are labelled UTC', () => {
  it('the sign-in alert says UTC', async () => {
    const { svc, sent, db, env } = setup()
    await svc.sendNewSignInAlert(env, db, ...CALLS.sendNewSignInAlert.slice(0, 1), 'Ann', { ip: '1.2.3.4', when: Date.UTC(2026, 9, 5, 23, 30) })
    expect(sent[0].html).toMatch(/Oct 5, 2026, 11:30 PM UTC/)
  })
  it('the receipt date is a UTC date and says so', async () => {
    const { svc, sent, db, env } = setup()
    await svc.sendPaymentReceipt(env, db, 'u@x.y', 'Ann', { fixTier: 'FIX', amountCents: 4900, currency: 'USD', reference: 'r', createdAt: '2026-10-05T23:30:00Z' })
    expect(sent[0].html).toMatch(/October 5, 2026 \(UTC\)/)
  })
})
