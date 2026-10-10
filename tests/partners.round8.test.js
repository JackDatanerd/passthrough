import { describe, it, expect, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Section 4 round 8: manual ledger adjustments, terms acceptance + notice, partner profile/notes editing,
// erasure that also clears mail/alert history, dashboard transparency, and the small fixes found alongside.

let t
afterEach(() => t?.restore())

const ctxOf = (over = {}) => ({
  env: { FRONTEND_URL: 'https://passthrough.dev', PAYSTACK_CURRENCY: 'USD', ...(over.env || {}) },
  get: k => (k === 'user' ? { id: 'admin-1' } : undefined),
  req: {
    param: k => (over.params || {})[k ?? 'id'] ?? 'p1',
    query: k => (over.query || {})[k],
    json: async () => over.body ?? {},
    header: k => (over.headers || {})[String(k).toLowerCase()],
  },
  header: () => {}, json: (body, status = 200) => ({ body, status }),
})

const PARTNER = {
  id: 'p1', name: 'Coach K', email: 'k@x.co', status: 'ACTIVE', payout_method: 'BANK',
  payout_details: { bankName: 'Acme Bank', accountNumber: '0123 4567 89' },
  payout_details_submitted_at: '2020-01-01T00:00:00.000Z', terms_version: null,
  payout_details_token: 'ptok', dashboard_token: 'dtok', commission_rate: 0.1, notify_conversions: true,
  internal_notes: 'secret note',
}

function setup(o = {}) {
  const st = { audits: [], emails: [], inserts: [], updates: [], deletes: [], ledgerUpdates: [], queries: [] }
  const partner = 'partner' in o ? o.partner : PARTNER
  const db = createFakeSupabase(q => {
    st.queries.push(q)
    if (q.table === 'admin_audit_log' && q.op === 'insert') { st.audits.push(q.values); return { data: null, error: null } }
    if (q.table === 'partners' && q.op === 'select') {
      if (o.partnersList) return { data: o.partnersList, count: o.partnersList.length, error: null }
      const eq = q.filters.find(f => f[0] === 'eq' && /token/.test(f[1]))
      if (eq) return { data: eq[2] === 'dtok' && eq[1] === 'dashboard_token' ? partner : (eq[2] === 'ptok' && eq[1] === 'payout_details_token' ? partner : null), error: null }
      return { data: partner, error: null }
    }
    if (q.table === 'partners' && q.op === 'update') { st.updates.push({ patch: q.patch, filters: q.filters }); return { data: o.updated ?? { ...partner, ...q.patch }, error: o.partnerUpdateError || null } }
    if (q.table === 'commission_ledger' && q.op === 'insert') { st.inserts.push(q.values); return { data: { id: 'adj1', created_at: 'now', ...q.values }, error: o.insertError || null } }
    if (q.table === 'commission_ledger' && q.op === 'select') return { data: o.unpaid ?? [], error: null }
    if (q.table === 'commission_ledger' && q.op === 'update') { st.ledgerUpdates.push({ patch: q.patch, filters: q.filters }); return { data: null, error: null } }
    if (q.table === 'email_logs' && q.op === 'delete') { st.deletes.push(q); return { count: 7, error: o.purgeError || null } }
    if (q.table === 'alert_logs' && q.op === 'delete') { st.deletes.push(q); return { count: 2, error: o.purgeError || null } }
    if (q.table === 'payouts' && q.op === 'select') return { data: [], error: null }
    return undefined
  })
  const mail = async name => { st.emails.push(name); return o.emailOk ?? true }
  const m = loadWithStubs('controllers/partners.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerAlert: async () => {},
      sendPartnerBalanceAdjusted: async (...a) => { st.emails.push(['adjusted', a[4], a[5], a[6]]); return o.emailOk ?? true },
      sendPartnerTermsUpdate: async (...a) => { st.emails.push(['terms', a[2]]); return o.termsMailOk ? o.termsMailOk(a[2]) : true },
      sendPartnerStatusChanged: async () => true, sendPartnerRateChanged: async () => true,
      sendPartnerLinkRegenerated: async () => true, sendPartnerEmailChanged: async () => true,
      sendPartnerPayoutDetailsRequest: async () => true, sendPayoutDetailsChanged: async () => true,
    },
  })
  return { ...m, st, db, mail }
}

describe('adjustments — the ledger entry', () => {
  it('records a signed ADJUSTMENT row with no payment/code, emails the partner, audits without the reason text', async () => {
    t = setup()
    const res = await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: -2500, reason: 'Self-referral via a second account' } }))
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.emailed).toBe(true)
    expect(t.st.inserts).toHaveLength(1)
    expect(t.st.inserts[0]).toMatchObject({
      partner_id: 'p1', kind: 'ADJUSTMENT', commission_amount_cents: -2500, gross_amount_cents: 0, commission_rate: 0,
      currency: 'USD', adjustment_reason: 'Self-referral via a second account', created_by: 'admin-1',
    })
    expect(t.st.inserts[0]).not.toHaveProperty('payment_id')
    expect(t.st.inserts[0]).not.toHaveProperty('referral_code_id')
    expect(res.body.data).toMatchObject({ kind: 'ADJUSTMENT', adjustmentReason: 'Self-referral via a second account', commissionAmountCents: -2500 })
    expect(t.st.emails[0].slice(0, 3)).toEqual(['adjusted', -2500, 'USD'])
    const audit = t.st.audits.find(a => a.action === 'partner.ledger_adjusted')
    expect(audit.detail).toMatchObject({ ledgerId: 'adj1', amountCents: -2500 })
    expect(JSON.stringify(audit)).not.toContain('second account')
  })

  it('rejects zero, absurd amounts and a missing reason', async () => {
    t = setup()
    await expect(t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 0, reason: 'nope nope' } }))).rejects.toThrow()
    await expect(t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 100000001, reason: 'too big' } }))).rejects.toThrow()
    await expect(t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 100, reason: ' ' } }))).rejects.toThrow()
    await expect(t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 1.5, reason: 'fractional' } }))).rejects.toThrow()
    expect(t.st.inserts).toHaveLength(0)
  })

  it('404s an unknown partner and 409s a removed one', async () => {
    t = setup({ partner: null })
    expect((await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 100, reason: 'bonus here' } }))).status).toBe(404)
    t.restore()
    t = setup({ partner: { ...PARTNER, email: 'partner-p1@removed.invalid' } })
    const res = await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 100, reason: 'bonus here' } }))
    expect([409]).toContain(res.status)
    expect(res.body.code).toBe('PARTNER_REMOVED')
    expect(t.st.inserts).toHaveLength(0)
  })

  it('notify:false records silently; a failed email still records the row and reports emailed:false', async () => {
    t = setup()
    const quiet = await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 500, reason: 'goodwill bonus', notify: false } }))
    expect(quiet.body.emailed).toBe(false)
    expect(t.st.emails).toHaveLength(0)
    t.restore()
    t = setup({ emailOk: false })
    const failed = await t.mod.adminAdjustLedger(ctxOf({ body: { amountCents: 500, reason: 'goodwill bonus' } }))
    expect(failed.body.success).toBe(true)
    expect(failed.body.emailed).toBe(false)
    expect(t.st.inserts).toHaveLength(1)
  })
})

describe('adjustments — cycle maths', () => {
  const day = d => new Date(Date.now() - d * 86400000).toISOString()
  it('is never held, never a conversion, and counts as an outside credit from a closed cycle', async () => {
    t = setup()
    const { buildCyclesSummary } = t.mod
    const old = new Date(); old.setUTCDate(old.getUTCDate() <= 15 ? 1 : 16); old.setUTCMonth(old.getUTCMonth() - 1)
    const sale = { id: 's1', kind: 'SALE', gross_amount_cents: 10000, commission_amount_cents: 2000, payout_id: null, reverses_ledger_id: null, created_at: old.toISOString(), payments: { status: 'SUCCESS' } }
    const adj = { id: 'a1', kind: 'ADJUSTMENT', gross_amount_cents: 0, commission_amount_cents: -500, payout_id: null, reverses_ledger_id: null, created_at: day(0), payments: null }
    const cycles = buildCyclesSummary([sale, adj], 4, 30)
    const cur = cycles.find(c => c.isCurrent)
    expect(cur.ledgerCount).toBe(0)               // an adjustment is not a conversion
    expect(cur.heldCents).toBe(0)                 // and is never held, even inside the hold window
    expect(cur.unpaidCents).toBe(-500)
  })
})

describe('adjustments — payout settlement', () => {
  it('a cycle-scoped payout pulls unpaid ADJUSTMENT rows from other closed cycles, like refund credits', async () => {
    const st = { queries: [] }
    t = setup()
    const db = createFakeSupabase(q => {
      st.queries.push(q)
      if (q.table === 'partners' && q.op === 'select') return { data: { ...PARTNER, payout_details_submitted_at: '2020-01-01T00:00:00.000Z' }, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') {
        if ((q.or || []).includes('reverses_ledger_id.not.is.null,kind.eq.ADJUSTMENT'))
          return { data: [{ id: 'adj', commission_amount_cents: -1000, reverses_ledger_id: null, kind: 'ADJUSTMENT', payments: null }], error: null }
        if (q.filters.some(f => f[0] === 'in')) return { data: [], error: null }
        return { data: [{ id: 'sale', commission_amount_cents: 5000, reverses_ledger_id: null, kind: 'SALE', payments: { status: 'SUCCESS' } }], error: null }
      }
      if (q.table === 'commission_ledger' && q.op === 'update') { st.claimed = (q.filters.find(f => f[0] === 'in') || [])[2]; return { data: st.claimed.map(id => ({ id, commission_amount_cents: 0 })), error: null } }
      if (q.table === 'payouts' && q.op === 'insert') { st.payout = q.values; return { data: { id: 'po1', ...q.values }, error: null } }
      return undefined
    })
    t.restore()
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerAlert: async () => {}, sendPayoutSent: async () => true },
    })
    const res = await t.mod.adminRecordPayout(ctxOf({ body: { periodStart: '2020-01-01T00:00:00.000Z', periodEnd: '2020-01-15T23:59:59.999Z' } }))
    expect(res.body.success).toBe(true)
    expect(st.payout.amount_cents).toBe(4000)             // 5000 sale - 1000 clawback
    expect([...st.claimed].sort()).toEqual(['adj', 'sale'])
  })

  it('the hold-window filter always lets an ADJUSTMENT through', async () => {
    const seen = []
    const db = createFakeSupabase(q => {
      if (q.table === 'partners' && q.op === 'select') return { data: PARTNER, error: null }
      if (q.table === 'commission_ledger' && q.op === 'select') { seen.push(q); return { data: [], error: null } }
      return undefined
    })
    t = loadWithStubs('controllers/partners.controller.js', {
      'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerAlert: async () => {} },
    })
    await t.mod.adminRecordPayout(ctxOf({ env: { COMMISSION_HOLD_DAYS: '14' }, body: { amountCents: 100, acknowledgeDifference: true } }))
    expect(seen[0].or[0]).toMatch(/^reverses_ledger_id\.not\.is\.null,kind\.eq\.ADJUSTMENT,created_at\.lte\./)
  })
})

describe('terms acceptance', () => {
  it('records the current version for a partner who never accepted (admin-created)', async () => {
    t = setup()
    const res = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(res.body).toMatchObject({ success: true, alreadyAccepted: false, termsVersion: '2026-10' })
    expect(t.st.updates[0].patch).toMatchObject({ terms_version: '2026-10' })
    expect(typeof t.st.updates[0].patch.terms_accepted_at).toBe('string')
  })
  it('is idempotent once current, rejects a bad token and a removed partner', async () => {
    t = setup({ partner: { ...PARTNER, terms_version: '2026-10' } })
    const again = await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))
    expect(again.body.alreadyAccepted).toBe(true)
    expect(t.st.updates).toHaveLength(0)
    expect((await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'wrong' } }))).status).toBe(404)
    expect((await t.mod.acceptPartnerTerms(ctxOf())).status).toBe(400)
    t.restore()
    t = setup({ partner: { ...PARTNER, email: 'partner-p1@removed.invalid' } })
    expect((await t.mod.acceptPartnerTerms(ctxOf({ headers: { 'x-partner-token': 'dtok' } }))).status).toBe(404)
  })
})

describe('terms notice', () => {
  const people = [
    { id: 'a', name: 'A', email: 'a@x.co', dashboard_token: 'ta' },
    { id: 'b', name: 'B', email: 'b@x.co', dashboard_token: 'tb' },
    { id: 'r', name: 'R', email: 'partner-r@removed.invalid', dashboard_token: 'tr' },
  ]
  it('mails each un-notified partner once, marks them notified, skips removed ones, reports the rest', async () => {
    t = setup({ partnersList: people })
    const res = await t.mod.adminSendTermsNotice(ctxOf())
    expect(res.body).toMatchObject({ success: true, version: '2026-10', sent: 2, failed: 0 })
    expect(t.st.emails.filter(e => e[0] === 'terms').map(e => e[1])).toEqual(['a@x.co', 'b@x.co'])
    expect(t.st.updates.map(u => u.patch)).toEqual([{ terms_notified_version: '2026-10' }, { terms_notified_version: '2026-10' }])
    const sel = t.st.queries.find(q => q.table === 'partners' && q.op === 'select')
    expect(sel.or).toHaveLength(2)
    expect(sel.limit).toBe(40)
  })
  it('does not mark a partner notified when the email failed', async () => {
    t = setup({ partnersList: people.slice(0, 2), termsMailOk: to => to !== 'a@x.co' })
    const res = await t.mod.adminSendTermsNotice(ctxOf())
    expect(res.body).toMatchObject({ sent: 1, failed: 1, remaining: 1 })
    expect(t.st.updates).toHaveLength(1)
  })
})

describe('partner profile + internal notes', () => {
  it('edits website/audience/notes, treats "" as clear, and audits field names only', async () => {
    t = setup()
    const res = await t.mod.adminUpdatePartner(ctxOf({ body: { website: ' https://k.example ', audience: '', internalNotes: 'met at conf; watch for fraud' } }))
    expect(res.body.success).toBe(true)
    const patch = t.st.updates[0].patch
    expect(patch).toMatchObject({ website: 'https://k.example', audience: null, internal_notes: 'met at conf; watch for fraud' })
    const audit = t.st.audits.find(a => a.action === 'partner.update')
    expect(audit.detail.profileEdited).toEqual(['website', 'audience', 'internalNotes'])
    expect(JSON.stringify(audit)).not.toContain('watch for fraud')
  })
  it('validates length and email bounds', async () => {
    t = setup()
    await expect(t.mod.adminUpdatePartner(ctxOf({ body: { internalNotes: 'x'.repeat(2001) } }))).rejects.toThrow()
    await expect(t.mod.adminUpdatePartner(ctxOf({ body: { email: `${'a'.repeat(320)}@x.co` } }))).rejects.toThrow()
    await expect(t.mod.adminCreatePartner(ctxOf({ body: { name: 'N', email: `${'a'.repeat(320)}@x.co` } }))).rejects.toThrow()
  })
})

describe('erasure', () => {
  it('removes notes + adjustment reasons and purges partner mail/alert history (the bug)', async () => {
    t = setup({ unpaid: [] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.logsPurged).toBe(true)
    expect(t.st.updates.find(u => u.patch.name === 'Removed partner').patch.internal_notes).toBeNull()
    const adj = t.st.ledgerUpdates.find(u => u.patch.adjustment_reason)
    expect(adj.patch.adjustment_reason).toBe('Adjustment (details removed)')
    expect(adj.filters).toContainEqual(['eq', 'kind', 'ADJUSTMENT'])

    const emailDel = t.st.deletes.find(q => q.table === 'email_logs')
    expect(emailDel.filters.find(f => f[0] === 'in' && f[1] === 'to')[2]).toContain('k@x.co')
    const tpl = emailDel.filters.find(f => f[0] === 'in' && f[1] === 'template')[2]
    expect(tpl).toContain('partner_payout_details_request')
    expect(tpl).not.toContain('verify_email')                 // candidate mail is never touched
    const alertPatterns = t.st.deletes.filter(q => q.table === 'alert_logs').map(q => q.filters.find(f => f[0] === 'ilike')[2])
    expect(alertPatterns).toEqual(['%k@x.co%', '%p1%'])
  })
  it('a failed purge never fails the erasure (rows age out with the retention sweep) and is reported', async () => {
    t = setup({ unpaid: [], purgeError: { message: 'db down' } })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(res.body.success).toBe(true)
    expect(res.body.logsPurged).toBe(false)
  })
  it('still refuses with a balance, and the message now points at write-off', async () => {
    t = setup({ unpaid: [{ id: 'x', commission_amount_cents: 700 }] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/write the balance off/)
  })
  it('a write-off adjustment zeroes the balance so erasure can proceed', async () => {
    t = setup({ unpaid: [{ id: 'x', commission_amount_cents: 700 }, { id: 'adj', commission_amount_cents: -700 }] })
    const res = await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(res.body.success).toBe(true)
  })
  it('does not purge anything for a partner that was already removed', async () => {
    t = setup({ unpaid: [], partner: { ...PARTNER, email: 'partner-p1@removed.invalid' } })
    await t.mod.adminAnonymizePartner(ctxOf({ body: { reason: 'Erasure request' } }))
    expect(t.st.deletes).toHaveLength(0)
  })
})

describe('partner-facing transparency', () => {
  const dashRow = {
    name: 'Coach K', commission_rate: 0.2, status: 'ACTIVE', payout_method: 'BANK',
    payout_details: PARTNER.payout_details, payout_details_submitted_at: new Date().toISOString(), terms_version: null,
    notify_conversions: true, referral_codes: [], payouts: [],
    commission_ledger: [
      { id: 'l2', kind: 'ADJUSTMENT', adjustment_reason: 'Bonus for the webinar', gross_amount_cents: 0, commission_rate: 0, commission_amount_cents: 1500, payout_id: null, reverses_ledger_id: null, referral_code_id: null, created_at: new Date().toISOString(), payments: null },
    ],
  }
  function dash(row = dashRow, env = {}) {
    const db = createFakeSupabase(q => (q.table === 'partners' ? { data: q.filters.some(f => f[0] === 'eq' && f[1] === 'dashboard_token' && f[2] === 'dtok') ? row : null, error: null } : undefined))
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': {} })
    return t.mod.getPartnerDashboard(ctxOf({ headers: { 'x-partner-token': 'dtok' }, env }))
  }
  it('shows the account on file as last four only, the hold, the terms prompt, and adjustments with their reason', async () => {
    const res = await dash()
    const d = res.body.data
    expect(d.payoutAccount).toEqual({ method: 'BANK', provider: 'Acme Bank', last4: '6789' })
    expect(JSON.stringify(d)).not.toContain('0123')
    expect(d.payoutHoldUntil).toBeTruthy()                       // changed just now, 48h default hold
    expect(d.termsAcceptanceRequired).toBe(true)
    expect(d.currentTermsVersion).toBe('2026-10')
    expect(d.conversions[0]).toMatchObject({ isAdjustment: true, adjustmentReason: 'Bonus for the webinar', commissionAmountCents: 1500 })
    expect(d.stats.totalConversions).toBe(0)                     // a bonus is not a conversion
    expect(d.stats.pendingCents).toBe(1500)
    expect(d).not.toHaveProperty('internalNotes')
    t.restore()
  })
  it('no hold once the window passed, and no terms prompt once accepted', async () => {
    const res = await dash({ ...dashRow, payout_details_submitted_at: '2020-01-01T00:00:00.000Z', terms_version: '2026-10' })
    expect(res.body.data.payoutHoldUntil).toBeNull()
    expect(res.body.data.termsAcceptanceRequired).toBe(false)
    t.restore()
  })
  it('submitPayoutDetails tells the partner about the hold', async () => {
    t = setup()
    const body = { payoutMethod: 'BANK', bankName: 'New Bank', accountName: 'Coach K', accountNumber: '1111222233' }
    const res = await t.mod.submitPayoutDetails(ctxOf({ headers: { 'x-partner-token': 'ptok' }, body }))
    expect(res.body).toMatchObject({ success: true, payoutDetailsHoldHours: 48 })
    expect(Date.parse(res.body.payoutHoldUntil)).toBeGreaterThan(Date.now() + 47 * 3600000)
  })
})

describe('small fixes', () => {
  it('a taken referral code gets a specific 409 message', async () => {
    t = setup({ insertError: null })
    // route the referral_codes insert to a unique violation
    const db = createFakeSupabase(q => {
      if (q.table === 'partners') return { data: PARTNER, error: null }
      if (q.table === 'referral_codes' && q.op === 'insert') return { data: null, error: { code: '23505', message: 'dup' } }
      return undefined
    })
    t.restore()
    t = loadWithStubs('controllers/partners.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': {} })
    const res = await t.mod.adminCreateReferralCode(ctxOf({ body: { code: 'dup20', tierPrices: { FIX: 1000 } } }))
    expect(res.status).toBe(409)
    expect(res.body.message).toMatch(/already in use/)
  })
})
