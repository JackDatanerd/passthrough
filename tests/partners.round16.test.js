import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { normalizeSub } from '../src/lib/referralSub.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Section 4 round 16: payout-link rotation is undone when the email does not go, admin "copy payout link" tells the partner,
// the audit log carries no code text, the application form answers before its mails, and channel tags (?sub=) are validated.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://usepassthrough.com', PAYSTACK_CURRENCY: 'USD' },
  get: () => ({ id: 'admin-1' }),
  req: {
    param: () => over.param ?? 'p1', query: () => undefined,
    json: async () => over.body ?? {},
    header: n => (String(n).toLowerCase() === 'x-partner-token' ? 'raw-dashboard-token' : undefined)
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(o = {}) {
  const st = { updates: [], emails: [], audits: [], inserts: [] }
  const db = createFakeSupabase(q => {
    if (q.table === 'partners' && q.op === 'update') { st.updates.push(q); return { data: { id: 'p1' }, error: null } }
    if (q.table === 'partners' && q.op === 'select' && o.noPartner) return { data: null, error: null }
    if (q.table === 'partners' && q.op === 'select') {
      const cols = q.cols || ''
      if (cols.includes('payout_token_hash') && !cols.includes('email')) return { data: { payout_token_hash: 'OLDHASH' }, error: null }
      return { data: { id: 'p1', name: 'Ann', email: 'ann@x.co', dashboard_token: 'd1' }, error: null }
    }
    if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    if (q.op === 'insert') { st.inserts.push(q); return { data: null, error: null } }
    return undefined
  })
  const mail = name => async (...a) => { st.emails.push([name, a]); return o.sent ?? true }
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendPartnerPayoutDetailsRequest: mail('payoutRequest'),
      sendPartnerLinkRegenerated: mail('regenerated'),
      sendOwnerAlert: o.alert ?? mail('ownerAlert'),
      sendPartnerApplicationReceived: o.received ?? mail('received'),
    },
    'lib/turnstile.js': { verifyTurnstile: async () => true },
  })
  return { ...m, st, db }
}

describe('normalizeSub', () => {
  it('lower-cases and accepts 1-32 of a-z 0-9 _ -', () => {
    expect(normalizeSub(' NewsLetter-1 ')).toBe('newsletter-1')
    expect(normalizeSub('a'.repeat(32))).toBe('a'.repeat(32))
  })
  it('drops anything else instead of throwing', () => {
    for (const bad of ['', 'a'.repeat(33), 'two words', 'x@y.co', '<b>', null, undefined, 5, {}]) expect(normalizeSub(bad)).toBeNull()
  })
})

describe('requestPayoutLink: a failed email never strands the partner (round 16)', () => {
  it('puts the previous link back when the email did not go, and still answers neutrally', async () => {
    t = load({ sent: false })
    const out = await t.mod.requestPayoutLink(ctxOf())
    expect(out.status).toBe(200)
    expect(out.body.success).toBe(true)
    const undo = t.st.updates.filter(u => u.patch && Object.keys(u.patch).join() === 'payout_token_hash')
    expect(undo).toHaveLength(1)
    expect(undo[0].patch.payout_token_hash).toBe('OLDHASH')
    expect(undo[0].filters.some(f => f[0] === 'eq' && f[1] === 'payout_token_hash')).toBe(true)   // guarded on the new hash
  })
  it('keeps the new link when the email went', async () => {
    t = load({ sent: true })
    const out = await t.mod.requestPayoutLink(ctxOf())
    expect(out.body.success).toBe(true)
    expect(t.st.updates.filter(u => u.patch && Object.keys(u.patch).join() === 'payout_token_hash')).toHaveLength(0)
    expect(t.st.emails.filter(e => e[0] === 'payoutRequest')).toHaveLength(1)
  })
})

describe('adminGetPartnerLinks (round 16)', () => {
  it('tells the partner when copying the payout link replaced theirs', async () => {
    t = load()
    const out = await t.mod.adminGetPartnerLinks(ctxOf())
    expect(out.body.data.payoutUrl).toContain('/partner/payout-details?token=')
    await new Promise(r => setTimeout(r, 0))
    const mail = t.st.emails.find(e => e[0] === 'regenerated')
    expect(mail).toBeTruthy()
    expect(mail[1][4]).toContain('/partner/payout-details?token=')
  })
  it('the dashboard-only scope rotates nothing and sends nothing', async () => {
    t = load()
    const ctx = ctxOf(); ctx.req.query = n => (n === 'scope' ? 'dashboard' : undefined)
    await t.mod.adminGetPartnerLinks(ctx)
    expect(t.st.emails).toHaveLength(0)
    expect(t.st.updates).toHaveLength(0)
  })
})

describe('applyAsPartner answers before its mails (round 16)', () => {
  it('does not wait for the owner alert or the applicant mail', async () => {
    const never = () => new Promise(() => {})
    const calls = []
    t = load({ noPartner: true, alert: (...a) => { calls.push('alert'); return never() }, received: (...a) => { calls.push('received'); return never() } })
    const body = { name: 'Ann', email: 'ann@x.co', acceptTerms: true }
    const done = await Promise.race([
      t.mod.applyAsPartner(ctxOf({ body })).then(() => 'answered'),
      new Promise(r => setTimeout(() => r('timeout'), 1500))
    ])
    expect(done).toBe('answered')
    expect(t.st.inserts.some(i => i.table === 'partner_applications')).toBe(true)   // it really took the fresh-application path
    expect(calls.sort()).toEqual(['alert', 'received'])
  })
})

describe('buildSubMix (round 16)', () => {
  it('counts net sales per tag, leaves out refunded / reversal / adjustment / untagged rows, most sales first', () => {
    const rows = [
      { id: 'a', attribution_sub: 'news', commission_amount_cents: 100, kind: 'SALE' },
      { id: 'b', attribution_sub: 'news', commission_amount_cents: 100, kind: 'SALE' },
      { id: 'c', attribution_sub: 'yt', commission_amount_cents: 50, kind: 'SALE' },
      { id: 'd', attribution_sub: 'yt', commission_amount_cents: 50, kind: 'SALE' },
      { id: 'd-rev', attribution_sub: 'yt', commission_amount_cents: -50, kind: 'SALE', reverses_ledger_id: 'd' },
      { id: 'e', attribution_sub: null, commission_amount_cents: 70, kind: 'SALE' },
      { id: 'f', attribution_sub: 'x', commission_amount_cents: 9, kind: 'ADJUSTMENT' },
    ]
    t = load()
    expect(t.mod.buildSubMix(rows)).toEqual([
      { sub: 'news', sales: 2, commissionCents: 200 },
      { sub: 'yt', sales: 1, commissionCents: 50 },
    ])
  })
})

describe('source guards (round 16)', () => {
  const src = rel => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')
  it('no referral-code audit entry carries the code text', () => {
    const t = src('src/controllers/partners.controller.js')
    for (const m of t.matchAll(/logAdminAction\([^)]*'partner\.referral_code_(?:created|updated)'[\s\S]{0,260}?\}\)/g)) {
      expect(m[0]).not.toMatch(/\bcode:\s/)
      expect(m[0]).toMatch(/codeId:/)
    }
  })
  it('checkout accepts a lenient referralSub and stores it only alongside a priced code', () => {
    const t = src('src/controllers/payments.controller.js')
    expect(t).toMatch(/referralSub:\s*z\.unknown\(\)\.optional\(\)\.transform\(normalizeSub\)/)
    expect(t).toMatch(/finalPriced\.referralCode && parsed\.data\.referralSub \? \{ referral_sub: parsed\.data\.referralSub \}/)
  })
  it('recordConversion copies payments.referral_sub to commission_ledger.attribution_sub only when present', () => {
    expect(src('src/services/referral.service.js')).toMatch(/payment\.referral_sub \? \{ attribution_sub: payment\.referral_sub \}/)
  })
})
