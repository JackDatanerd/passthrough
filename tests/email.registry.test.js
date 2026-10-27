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
  const env = { FRONTEND_URL: 'https://usepassthrough.com', EMAIL_FROM: 'P <hello@usepassthrough.com>', OWNER_ALERT_EMAIL: 'o@x.y', PAYSTACK_CURRENCY: 'USD', RATE_LIMIT_KV: {} }
  return { svc: t.mod, sent, refunds, logs, db, env }
}

const CALLS = {
  sendWelcome: ['u@x.y', 'Ann'], sendWelcomeOffer: ['u@x.y', 'Ann', { code: 'AN-7K2QH', percentOff: 30, amountCents: 2030, listAmountCents: 2900, currency: 'USD', expiresAt: '2026-11-04T00:00:00.000Z' }], sendVerification: ['u@x.y', 'Ann', 'tok'], sendPasswordReset: ['u@x.y', 'Ann', 'tok'],
  sendPasswordChanged: ['u@x.y', 'Ann'], sendEmailChangedOldAddress: ['u@x.y', 'Ann', 'n@x.y'], sendEmailChangeCompleted: ['u@x.y', 'Ann', 'n@x.y'],
  sendEmailChangeConfirmation: ['n@x.y', 'Ann', 'tok'], sendAccountDeleted: ['u@x.y', 'Ann'], sendAccountLockoutAlert: ['u@x.y', 'Ann', 15],
  sendNewSignInAlert: ['u@x.y', 'Ann', { ip: '1.2.3.4', when: Date.UTC(2026, 9, 5, 23, 30) }],
  sendScanFail: ['u@x.y', 'Ann', 60, { keywordScore: 1, formatScore: 2, sectionsScore: 3, contentScore: 4 }], sendScanPass: ['u@x.y', 'Ann', 85],
  sendAnonScanResult: ['u@x.y', 'Ann', 'sid', 'tok', 85, true], sendFixDelivered: ['u@x.y', 'Ann', 'ABC', 'https://v', true], sendBadgeDelivered: ['u@x.y', 'Ann', 'ABC', 'https://v', true],
  sendVerificationReported: ['u@x.y', 'Ann', { code: 'AB3XY7K2PQ', phrase: 'that something on it is wrong', pageUrl: 'https://usepassthrough.com/v/AB3XY7K2PQ' }],
  sendFixDeliveredPlain: ['u@x.y', 'Ann'], sendFixFailed: ['u@x.y', 'Ann'], sendOutcomeFollowUp: ['u@x.y', 'Ann'],
  sendPaymentReceipt: ['u@x.y', 'Ann', { fixTier: 'FIX', amountCents: 4900, currency: 'USD', reference: 'ref1', createdAt: '2026-10-05T23:30:00Z' }],
  sendPaymentReversed: ['u@x.y', 'Ann', { amountCents: 4900, currency: 'USD', reference: 'ref1', reason: 'REFUND', verificationRevoked: true }],
  sendPartnerPayoutDetailsRequest: ['p@x.y', 'P', 'https://u'], sendPayoutSent: ['p@x.y', 'P', 1000, 'USD'], sendReferralCodeCreated: ['p@x.y', 'P', 'CODE', 'https://d'],
  sendPayoutDetailsChanged: ['p@x.y', 'P', 'BANK'], sendPartnerLinkRegenerated: ['p@x.y', 'P', 'https://u'], sendPartnerEmailChanged: ['p@x.y', 'P', 'o@x.y', 'n@x.y'],
  sendPartnerConversionEarned: ['p@x.y', 'P', 'CODE', 500, 'USD', 'https://d'],
  sendPartnerLinksSelfReset: ['p@x.y', 'P', 'https://d', 'https://u'], sendPartnerCodeLimitReached: ['p@x.y', 'P', 'CODE', 10], sendPartnerCodeExpiring: ['p@x.y', 'P', 'CODE', '2026-11-01T00:00:00Z'], sendPartnerTermsAccepted: ['p@x.y', 'P', '2026-10'], sendPartnerStatusChanged: ['p@x.y', 'P', 'PAUSED'], sendPartnerCodeChanged: ['p@x.y', 'P', 'CODE', [{ field: 'active', to: false }], 'USD'], sendPartnerApplicationRejected: ['p@x.y', 'P', 'Not a fit yet.'], sendPartnerApplicationReceived: ['p@x.y', 'P'],
  sendPartnerRateChanged: ['p@x.y', 'P', 0.2, 0.25], sendPartnerCommissionReversed: ['p@x.y', 'P', 500, 'USD', 'https://d'], sendPartnerSaleMoved: ['p@x.y', 'P', 'away', 580, 'USD'],
  sendPartnerLinksRecovery: ['p@x.y', 'P', 'https://d'],
  sendPartnerBalanceAdjusted: ['p@x.y', 'P', -500, 'USD', 'Self-referral via a second account', 'https://d'],
  sendPartnerTermsUpdate: ['p@x.y', 'P', '2026-10', 'https://t', 'https://d'],
  sendPartnerPayoutDetailsReminder: ['p@x.y', 'P', 4500, 'KES', 'https://d'],
  sendPartnerDashboardLinkRegenerated: ['p@x.y', 'P', 'https://d'], sendPartnerPayoutVoided: ['p@x.y', 'P', 500, 'USD', 'Entered against the wrong cycle.'],
  sendEmployerLeadRejoin: ['l@x.y', { rejoinUrl: 'https://j', removeUrl: 'https://r', unsubscribeUrl: 'https://u' }],
  sendEmployerLeadAck: ['l@x.y', 'Lee', 'Design', { confirmUrl: 'https://c', removeUrl: 'https://r', prefsUrl: 'https://p', unsubscribeUrl: 'https://u' }],
  sendEmployerCandidatesAvailable: ['l@x.y', 'Lee', 'Design', 3, { removeUrl: 'https://r', prefsUrl: 'https://p', unsubscribeUrl: 'https://u' }],
}

describe('email templates — every sender renders through the real templates', () => {
  it('every exported send* function is covered by this table', () => {
    const { svc } = setup()
    const senders = Object.keys(svc).filter(k => /^send[A-Z]/.test(k) && !['sendOwnerAlert', 'sendOwnerNotice', 'sendSupportInboxNotice'].includes(k))   // owner-facing, no template
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
    const ok = await svc.sendEmployerLeadAck(env, db, 'l@x.y', 'Lee', 'Design', { confirmUrl: 'a', removeUrl: 'b', prefsUrl: 'p', unsubscribeUrl: 'c' })
    expect(ok).toBe(false)
    expect(sent).toHaveLength(0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ status: 'failed', error: 'Unknown email template: nope' })
    expect(refunds.length).toBe(1)
  })

  it('a Resend failure is logged as failed and refunds the slot', async () => {
    const { svc, logs, refunds, db, env } = setup({ failSend: 'Resend down' })
    expect(await svc.sendEmployerLeadAck(env, db, 'l@x.y', 'Lee', 'Design', { confirmUrl: 'a', removeUrl: 'b', prefsUrl: 'p', unsubscribeUrl: 'c' })).toBe(false)
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

describe('delivery emails — cover letter and the result page', () => {
  const cases = [
    ['sendFixDelivered', ['u@x.y', 'Ann', 'ABC', 'https://v', true, 'scan-42']],
    ['sendFixDelivered', ['u@x.y', 'Ann', 'ABC', 'https://v', false, 'scan-42']],
    ['sendBadgeDelivered', ['u@x.y', 'Ann', 'ABC', 'https://v', true, 'scan-42']],
    ['sendBadgeDelivered', ['u@x.y', 'Ann', 'ABC', 'https://v', false, 'scan-42']],
    ['sendFixDeliveredPlain', ['u@x.y', 'Ann', 'scan-42']],
  ]
  for (const [fn, args] of cases) {
    it(`${fn}${args[4] === false ? ' (report)' : ''}: names the cover letter and links the buttons to /scan/<id>`, async () => {
      const { svc, sent, db, env } = setup()
      await svc[fn](env, db, ...args)
      expect(sent[0].html).toMatch(/cover letter/i)
      expect(sent[0].html).toContain('https://usepassthrough.com/scan/scan-42')
      expect(sent[0].html).not.toContain('/dashboard"')
    })
  }
  it('falls back to the dashboard when no scan id is given', async () => {
    const { svc, sent, db, env } = setup()
    await svc.sendFixDeliveredPlain(env, db, 'u@x.y', 'Ann')
    expect(sent[0].html).toContain('https://usepassthrough.com/dashboard')
  })
})

describe('credential-only delivery emails say what was actually done', () => {
  // The BADGE tier rewrites nothing: "your fixed resume" / "your rewritten resume" would be untrue.
  for (const verified of [true, false]) {
    it(`sendBadgeDelivered (${verified ? 'credential issued' : 'under the bar'}): subject and body never claim a rewrite`, async () => {
      const { svc, sent, db, env } = setup()
      await svc.sendBadgeDelivered(env, db, 'u@x.y', 'Ann', 'ABC', 'https://usepassthrough.com/v/ABC', verified, 'scan-42')
      expect(sent).toHaveLength(1)
      const text = `${sent[0].subject} ${String(sent[0].html).replace(/<[^>]+>/g, ' ')}`
      expect(text).not.toMatch(/fixed resume|rewritten resume/i)
      expect(text).toMatch(/Nothing in it was rewritten/)
      expect(sent[0].subject).toMatch(verified ? /Verified credential is ready/ : /formatted resume is ready/)
      expect(String(sent[0].html)).toContain('https://usepassthrough.com/scan/scan-42')
      if (!verified) expect(text).toMatch(/free fix credit/)
      else expect(text).toMatch(/Passthrough Verified/)
    })
  }
  it('and the full-fix emails keep saying so (nothing else changed)', async () => {
    const { svc, sent, db, env } = setup()
    await svc.sendFixDelivered(env, db, 'u@x.y', 'Ann', 'ABC', 'https://v', false, 'scan-42')
    expect(sent[0].subject).toBe('Your rewritten resume is ready')
  })
})
