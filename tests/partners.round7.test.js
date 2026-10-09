import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 7 — locks in every fix and feature from this pass.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://passthrough.dev', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? A,
    query: k => ('query' in over && k in over.query ? over.query[k] : k === 'token' ? over.token : undefined),
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

function load(db, emailStubs = {}, extra = {}) {
  return loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/turnstile.js': { verifyTurnstile: async () => true },
    'services/email.service.js': { sendOwnerAlert: async () => {}, ...emailStubs },
    ...extra,
  })
}

// ── B1: re-saving unchanged payout details ────────────────────────────────────────────────────────
describe('submitPayoutDetails — an unchanged resubmission is a no-op', () => {
  const stored = { bankName: 'Equity Bank', accountName: 'Coach K', accountNumber: '0123 4567 89' }
  function setup(previous) {
    const st = { updates: 0, emails: 0, alerts: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: previous, error: null }
      if (q.table === 'partners' && q.op === 'update') { st.updates++; return { data: { name: 'K', email: 'k@x.co' }, error: null } }
    })
    const m = load(db, { sendPayoutDetailsChanged: async () => { st.emails++ }, sendOwnerAlert: async () => { st.alerts++ } })
    return { ...m, st }
  }
  const body = (over = {}) => ({ payoutMethod: 'BANK', bankName: 'Equity Bank', accountName: 'Coach K', accountNumber: '01234567 89', ...over })

  it('does not write, restart the hold, or send either alert when nothing changed (spacing and case ignored)', async () => {
    t = setup({ payout_method: 'BANK', payout_details: stored })
    const res = await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: body({ bankName: 'equity  bank' }) }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, unchanged: true })
    expect(t.st).toEqual({ updates: 0, emails: 0, alerts: 0 })
  })
  it('a different account number is still a change: written, and both alerts fire', async () => {
    t = setup({ payout_method: 'BANK', payout_details: stored })
    const res = await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: body({ accountNumber: '9999999999' }) }))
    expect(res.status).toBe(200)
    expect(res.body.unchanged).toBeUndefined()
    expect(t.st.updates).toBe(1)
    expect(t.st.emails).toBe(1)
    expect(t.st.alerts).toBe(1)
  })
  it('a change of method is a change', async () => {
    t = setup({ payout_method: 'MOBILE_MONEY', payout_details: { provider: 'M-Pesa', accountName: 'Coach K', phoneNumber: '0712345678' } })
    await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: body() }))
    expect(t.st.updates).toBe(1)
  })
  it('the first-ever submission (nothing stored) is a change', async () => {
    t = setup({ payout_method: null, payout_details: null })
    await t.mod.submitPayoutDetails(ctxOf({ token: 'tok', body: body() }))
    expect(t.st.updates).toBe(1)
  })
})

// ── B2: track-click says plainly when a value is not a code ───────────────────────────────────────
describe('trackClick — malformed codes', () => {
  function setup() {
    const db = createFakeSupabase(() => undefined)
    return { ...load(db), db }
  }
  const c = code => ctxOf({ body: { code }, headers: { 'user-agent': 'Mozilla/5.0' } })
  it('an over-long value answers valid:false (the browser then drops it instead of keeping it)', async () => {
    t = setup()
    const res = await t.mod.trackClick(c('A'.repeat(51)))
    expect(res.body).toEqual({ success: true, valid: false })
    expect(t.db.calls).toHaveLength(0)
  })
  it('a value with characters a code can never contain answers valid:false without a lookup', async () => {
    t = setup()
    expect((await t.mod.trackClick(c('utm source'))).body).toEqual({ success: true, valid: false })
    expect(t.db.calls).toHaveLength(0)
  })
  it('a blank value is still a quiet success with no verdict', async () => {
    t = setup()
    expect((await t.mod.trackClick(c('   '))).body).toEqual({ success: true })
  })
})

// ── B4: conversion rate ───────────────────────────────────────────────────────────────────────────
describe('referral code conversion rate', () => {
  it('is reported when sales <= clicks and withheld when sales exceed clicks', () => {
    const src = require('node:fs').readFileSync(new URL('../src/controllers/partners.controller.js', import.meta.url), 'utf8')
    expect(src).toContain('st.conversions <= rc.clicks ? st.conversions / rc.clicks : null')
  })
})

// ── B5: adminUpdatePartner must not skip its safeguards when the read fails ───────────────────────
describe('adminUpdatePartner — failed read of the current row', () => {
  it('fails the request instead of changing the email without rotating tokens or alerting anyone', async () => {
    const st = { updates: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: null, error: { message: 'read failed' } }
      if (q.table === 'partners' && q.op === 'update') { st.updates++; return { data: {}, error: null } }
    })
    t = { ...load(db), st }
    await expect(t.mod.adminUpdatePartner(ctxOf({ body: { email: 'new@x.co' } }))).rejects.toBeTruthy()
    expect(st.updates).toBe(0)
  })
  it('refuses to edit a partner whose data was removed (no re-activating, no new address)', async () => {
    const st = { updates: 0 }
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: { email: 'partner-x@removed.invalid', status: 'PAUSED', commission_rate: 0.2 }, error: null }
      if (q.table === 'partners' && q.op === 'update') { st.updates++; return { data: {}, error: null } }
    })
    t = load(db)
    const res = await t.mod.adminUpdatePartner(ctxOf({ body: { status: 'ACTIVE' } }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('PARTNER_REMOVED')
    expect(st.updates).toBe(0)
  })
  it('404s for a partner that does not exist, without updating', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' && q.op === 'select') ? { data: null, error: null } : undefined)
    t = load(db)
    const res = await t.mod.adminUpdatePartner(ctxOf({ body: { email: 'new@x.co' } }))
    expect(res.status).toBe(404)
  })
})

// ── G1: "I lost my link" ──────────────────────────────────────────────────────────────────────────
describe('recoverPartnerLinks', () => {
  function setup({ partner, captcha = true } = {}) {
    const st = { sent: [], queries: [] }
    const db = createFakeSupabase(q => {
      st.queries.push(q)
      if (q.table === 'partners' && q.op === 'select') return { data: partner ? [partner] : [], error: null }
    })
    const m = load(db, { sendPartnerLinksRecovery: async (...a) => { st.sent.push(a.slice(2)); return true } },
      { 'lib/turnstile.js': { verifyTurnstile: async () => captcha } })
    return { ...m, st }
  }
  const row = { name: 'Coach K', email: 'k@x.co', dashboard_token: 'DTOK' }

  it('mails the READ-ONLY dashboard link (never the payout link) to the address on file', async () => {
    t = setup({ partner: row })
    const res = await t.mod.recoverPartnerLinks(ctxOf({ body: { email: ' K@X.co ' } }))
    await new Promise(r => setTimeout(r, 0))
    expect(res.status).toBe(200)
    expect(t.st.sent).toEqual([['k@x.co', 'Coach K', 'https://passthrough.dev/partner/dashboard?token=DTOK']])
    expect(JSON.stringify(t.st.sent)).not.toContain('payout-details')
  })
  it('gives the identical answer for an address that is not a partner, and sends nothing', async () => {
    t = setup({ partner: null })
    const known = setup({ partner: row })
    const a = await known.mod.recoverPartnerLinks(ctxOf({ body: { email: 'k@x.co' } }))
    known.restore()
    const b = await t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'nobody@x.co' } }))
    expect(b.body).toEqual(a.body)
    expect(b.status).toBe(a.status)
    expect(t.st.sent).toHaveLength(0)
  })
  it('never mails a removed (anonymized) partner', async () => {
    t = setup({ partner: { ...row, email: 'partner-x@removed.invalid' } })
    await t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'partner-x@removed.invalid' } }))
    expect(t.st.sent).toHaveLength(0)
  })
  it('escapes LIKE wildcards in the address so one cannot match another partner', async () => {
    t = setup({ partner: null })
    await t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'a_b@x.co' } }))
    const q = t.st.queries.find(x => x.table === 'partners')
    expect(q.filters.find(f => f[0] === 'ilike')[2]).toBe('a\\_b@x.co')
  })
  it('a filled honeypot looks like success but does nothing', async () => {
    t = setup({ partner: row })
    const res = await t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'k@x.co', company: 'Acme' } }))
    expect(res.status).toBe(200)
    expect(t.st.queries).toHaveLength(0)
  })
  it('refuses when the captcha fails, and looks nothing up', async () => {
    t = setup({ partner: row, captcha: false })
    const res = await t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'k@x.co' } }))
    expect(res.status).toBe(400)
    expect(t.st.queries).toHaveLength(0)
  })
  it('rejects a malformed email', async () => {
    t = setup({ partner: row })
    await expect(t.mod.recoverPartnerLinks(ctxOf({ body: { email: 'nope' } }))).rejects.toThrow()
  })
})

// ── G2: anonymize a partner ───────────────────────────────────────────────────────────────────────
describe('adminAnonymizePartner', () => {
  function setup({ owed = [], email = 'k@x.co', payouts = [] } = {}) {
    const st = { ops: [], audits: [], partnerPatch: null, payoutPatches: [], codePatch: null }
    const db = createFakeSupabase(q => {
      st.ops.push(`${q.op}:${q.table}`)
      if (q.table === 'partners' && q.op === 'select') return { data: { id: A, email }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') return { data: owed, error: null }
      if (q.table === 'partner_applications' && q.op === 'delete') return { data: null, error: null }
      if (q.table === 'referral_codes' && q.op === 'update') { st.codePatch = q.patch; return { data: null, error: null } }
      if (q.table === 'payouts' && q.op === 'select') return { data: payouts, error: null }
      if (q.table === 'payouts' && q.op === 'update') { st.payoutPatches.push(q.patch); return { data: null, error: null } }
      if (q.table === 'partners' && q.op === 'update') { st.partnerPatch = q.patch; return { data: null, error: null } }
      if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    })
    return { ...load(db), st, db }
  }
  const body = { reason: 'erasure request by email' }

  it('refuses while commission is still owed, and changes nothing', async () => {
    t = setup({ owed: [{ id: 'l1', commission_amount_cents: 500 }] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('COMMISSION_OWED')
    expect(t.st.ops.filter(o => /^(update|delete)/.test(o))).toEqual([])
  })
  it('refuses an unsettled refund credit too', async () => {
    t = setup({ owed: [{ id: 'l1', commission_amount_cents: -300 }] })
    expect((await t.mod.adminAnonymizePartner(ctxOf({ body }))).status).toBe(409)
  })
  it('requires a reason', async () => {
    t = setup()
    await expect(t.mod.adminAnonymizePartner(ctxOf({ body: { reason: '' } }))).rejects.toThrow()
  })
  it('wipes identity and payout details, rotates both tokens, pauses, switches codes off', async () => {
    t = setup()
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(res.status).toBe(200)
    expect(t.st.partnerPatch).toMatchObject({
      name: 'Removed partner', email: `partner-${A}@removed.invalid`, status: 'PAUSED',
      payout_method: null, payout_details: null, payout_details_submitted_at: null, website: null, audience: null, notify_conversions: false,
    })
    expect(t.st.partnerPatch.payout_details_token).toMatch(/\S{16,}/)
    expect(t.st.partnerPatch.dashboard_token).toMatch(/\S{16,}/)
    expect(t.st.partnerPatch.payout_details_token).not.toBe(t.st.partnerPatch.dashboard_token)
    expect(t.st.codePatch).toEqual({ active: false })
    expect(t.st.audits[0]).toMatchObject({ action: 'partner.anonymized' })
  })
  it('changes the partner row LAST, so a failure part-way leaves the original email for the retry', async () => {
    t = setup()
    await t.mod.adminAnonymizePartner(ctxOf({ body }))
    const idx = o => t.st.ops.indexOf(o)
    expect(idx('update:partners')).toBeGreaterThan(idx('delete:partner_applications'))
    expect(idx('update:partners')).toBeGreaterThan(idx('update:referral_codes'))
    expect(idx('update:partners')).toBeGreaterThan(idx('update:payouts') === -1 ? -1 : idx('update:payouts'))
  })
  it('deletes the applications by partner AND by the original email', async () => {
    t = setup({ email: 'k@x.co' })
    await t.mod.adminAnonymizePartner(ctxOf({ body }))
    const dels = t.db.calls.filter(c => c.table === 'partner_applications' && c.op === 'delete')
    expect(dels).toHaveLength(2)
    expect(dels[0].filters).toContainEqual(['eq', 'partner_id', A])
    expect(dels[1].filters).toContainEqual(['ilike', 'email', 'k@x.co'])
  })
  it('reduces each past payout snapshot to bank/provider and last four digits, keeping amounts untouched', async () => {
    t = setup({ payouts: [
      { id: 'p1', payout_method: 'BANK', payout_details_snapshot: { bankName: 'Equity', accountName: 'Coach K', accountNumber: '0123 4567 89' } },
      { id: 'p2', payout_method: 'MOBILE_MONEY', payout_details_snapshot: { provider: 'M-Pesa', accountName: 'Coach K', phoneNumber: '0712345678' } },
    ] })
    await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(t.st.payoutPatches).toEqual([
      { payout_details_snapshot: { bankName: 'Equity', accountName: 'Removed', accountNumber: '…6789' } },
      { payout_details_snapshot: { provider: 'M-Pesa', accountName: 'Removed', phoneNumber: '…5678' } },
    ])
  })
  it('is idempotent: an already-removed partner is checked and finished, not failed', async () => {
    t = setup({ email: `partner-${A}@removed.invalid` })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body }))
    expect(res.status).toBe(200)
    expect(res.body.alreadyRemoved).toBe(true)
    expect(t.db.calls.filter(c => c.table === 'partner_applications' && c.op === 'delete')).toHaveLength(1)
  })
  it('404s for an unknown partner', async () => {
    const db = createFakeSupabase(q => (q.table === 'partners' && q.op === 'select') ? { data: null, error: null } : undefined)
    t = load(db)
    expect((await t.mod.adminAnonymizePartner(ctxOf({ body }))).status).toBe(404)
  })
})

// ── G3: applications are paged ────────────────────────────────────────────────────────────────────
describe('adminListApplications — paging', () => {
  it('honours limit/offset, asks for an exact count, and returns the true total', async () => {
    const rows = [{ id: 'a1', name: 'N', email: 'e@x.co', status: 'PENDING', created_at: '2026-01-01T00:00:00Z' }]
    const db = createFakeSupabase(() => ({ data: rows, count: 312, error: null }))
    t = load(db)
    const res = await t.mod.adminListApplications(ctxOf({ query: { status: 'PENDING', limit: '50', offset: '100' } }))
    expect(res.body.total).toBe(312)
    expect(res.body.data).toHaveLength(1)
    const q = db.calls[0]
    expect(q.range).toEqual([100, 149])
    expect(q.selectOpts).toEqual({ count: 'exact' })
  })
  it('no longer hard-caps at 200', () => {
    const src = require('node:fs').readFileSync(new URL('../src/controllers/partners.controller.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/partner_applications'\)\.select\('\*'\)[^\n]*\n[^\n]*limit\(200\)/)
  })
})

// ── wiring ────────────────────────────────────────────────────────────────────────────────────────
describe('routes and templates', () => {
  const fs = require('node:fs')
  const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  it('/recover-links is public with its own limiter bucket; /:id/anonymize is admin-only', () => {
    const routes = read('../src/routes/partners.routes.js')
    expect(routes).toMatch(/router\.post\('\/recover-links', rl\.partnerRecover, c\.recoverPartnerLinks\)/)
    expect(routes).toMatch(/router\.post\(\s*'\/:id\/anonymize',\s+admin, validateUuidParam\(\), c\.adminAnonymizePartner\)/)
  })
  it('the recovery email template exists and carries only the dashboard link', () => {
    const { render } = require('../src/templates/emails.js')
    const html = render('partner_links_recovery', { NAME: 'K', DASHBOARD_URL: 'https://d.test/x', FRONTEND_URL: 'https://passthrough.dev' })
    expect(html).toContain('https://d.test/x')
    expect(html).not.toContain('{{')
  })
})
