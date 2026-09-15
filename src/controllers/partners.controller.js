// Manual-payout partner tracking + referral-code commission ledger.
//
// Three audiences hit this controller:
//   - The ADMIN (Jack) — gated by middleware/adminOnly.js.
//   - The PARTNER — no login system for them yet; identified by a long
//     random token mailed to them (payout_details_token), passed as
//     ?token=... on every public endpoint below. The same token gates both
//     their payout-details form and their stats dashboard.
//   - ANYONE (public, unauthenticated) — trackClick, fired by the frontend
//     whenever a ?ref=CODE link is visited. No sensitive data involved,
//     just a counter increment.

const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const emailService = require('../services/email.service')
const {
  partnerRowToCamel, payoutRowToCamel, referralCodeRowToCamel, commissionLedgerRowToCamel
} = require('../lib/mappers')

// Sum of commission_ledger rows not yet attached to a payout — the "owed"
// number both adminListPartners and adminRecordPayout rely on. Kept as one
// function so the two can never compute it differently.
function pendingCents(ledgerRows) {
  return (ledgerRows || []).filter(l => !l.payout_id).reduce((sum, l) => sum + l.commission_amount_cents, 0)
}

// ── Admin: create a partner ────────────────────────────────────────────────

const createPartnerSchema = z.object({
  name:         z.string().min(1).max(200),
  email:        z.string().email(),
  referralCode: z.string().min(2).max(50).optional()
})

async function adminCreatePartner(ctx) {
  const body = createPartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)
  const token = cryptoLib.randomToken(32)

  const { data, error } = await supabase.from('partners').insert({
    name:                 body.name,
    email:                body.email,
    referral_code:        body.referralCode || null,
    payout_details_token: token
  }).select('*').single()
  if (error) throw error

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${token}`
  // Best-effort — the partner record should exist even if the email send
  // fails (e.g. transient Resend error); admin can resend via adminResendPayoutLink.
  await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, body.email, body.name, payoutUrl)
    .catch(() => {})

  return ctx.json({ success: true, data: partnerRowToCamel(data) })
}

// ── Admin: list all partners + payout history + codes + pending balance ────
// This is "a way admin can reach the details" — payoutDetails comes back in
// full, and pendingCommissionCents tells Jack exactly what's owed before he
// records a payout, rather than him having to compute it by hand.

async function adminListPartners(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase
    .from('partners')
    .select(`
      *,
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, paid_at, created_at),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, created_at)
    `)
    .order('created_at', { ascending: false })
  if (error) throw error

  const partners = data.map(row => {
    const camel = partnerRowToCamel(row)
    camel.pendingCommissionCents = pendingCents(row.commission_ledger)
    return camel
  })
  return ctx.json({ success: true, data: partners })
}

// ── Admin: re-send a partner's payout-details link ──────────────────────────

async function adminResendPayoutLink(ctx) {
  const partnerId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners').select('name, email, payout_details_token').eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${partner.payout_details_token}`
  const sent = await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, partner.email, partner.name, payoutUrl)
  return ctx.json({ success: sent, message: sent ? 'Link re-sent.' : 'Email send failed — check logs.' })
}

// ── Admin: create a referral code for a partner ─────────────────────────────
// Emails the partner their code + dashboard link immediately — this is the
// moment their dashboard actually becomes useful, so it's the natural point
// to send them there rather than at partner-creation time.

const createReferralCodeSchema = z.object({
  code:       z.string().min(2).max(50),
  tierPrices: z.object({
    FIX:       z.number().int().positive().optional(),
    BADGE:     z.number().int().positive().optional(),
    FIX_PLAIN: z.number().int().positive().optional()
  }).refine(obj => Object.keys(obj).length > 0, 'At least one tier price is required.'),
  usageLimit: z.number().int().positive().optional(),
  expiresAt:  z.string().datetime().optional()
})

async function adminCreateReferralCode(ctx) {
  const partnerId = ctx.req.param('id')
  const body = createReferralCodeSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data: partner, error: pErr } = await supabase
    .from('partners').select('name, email, payout_details_token').eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const { data: codeRow, error } = await supabase.from('referral_codes').insert({
    partner_id:  partnerId,
    code:        body.code.trim().toUpperCase(),
    tier_prices: body.tierPrices,
    usage_limit: body.usageLimit || null,
    expires_at:  body.expiresAt || null
  }).select('*').single()
  if (error) throw error

  const dashboardUrl = `${ctx.env.FRONTEND_URL}/partner/dashboard?token=${partner.payout_details_token}`
  await emailService.sendReferralCodeCreated(ctx.env, supabase, partner.email, partner.name, codeRow.code, dashboardUrl)
    .catch(() => {})

  return ctx.json({ success: true, data: referralCodeRowToCamel(codeRow) })
}

// ── Admin: toggle a referral code active/inactive ───────────────────────────
// Deliberately no DELETE — payments.referral_code_id references this row,
// so codes get deactivated, never removed, to keep historical attribution intact.

async function adminSetReferralCodeActive(ctx) {
  const codeId = ctx.req.param('codeId')
  const { active } = z.object({ active: z.boolean() }).parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data, error } = await supabase.from('referral_codes')
    .update({ active }).eq('id', codeId).select('*').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Referral code not found.' }, 404)

  return ctx.json({ success: true, data: referralCodeRowToCamel(data) })
}

// ── Admin: record a payout that has ALREADY been sent manually ─────────────
// Captures amount + payout method at the moment of recording, emails the
// partner a confirmation, and settles every currently-unpaid commission_ledger
// row for that partner against this payout (see the simplification note below).

const recordPayoutSchema = z.object({
  // Optional — if omitted, defaults to the partner's full pending commission
  // balance. Admin can override for a partial payment, a rounded-up manual
  // transfer, or a payout with no ledger backing it at all (e.g. a one-off
  // bonus) — any of those are legitimate reasons to send a different number
  // than what the ledger currently shows.
  amountCents:  z.number().int().positive().optional(),
  currency:     z.string().length(3).default('USD'),
  payoutMethod: z.enum(['BANK', 'MOBILE_MONEY']).optional(),
  note:         z.string().max(500).optional()
})

async function adminRecordPayout(ctx) {
  const partnerId = ctx.req.param('id')
  const body = recordPayoutSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data: partner, error: pErr } = await supabase
    .from('partners').select('*').eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutMethod = body.payoutMethod || partner.payout_method
  if (!payoutMethod)
    return ctx.json({ success: false,
      message: 'This partner has not submitted payout details yet — nothing to pay to.' }, 400)

  const { data: unpaidLedger, error: ledgerErr } = await supabase
    .from('commission_ledger').select('id, commission_amount_cents')
    .eq('partner_id', partnerId).is('payout_id', null)
  if (ledgerErr) throw ledgerErr

  const owedCents  = unpaidLedger.reduce((sum, l) => sum + l.commission_amount_cents, 0)
  const amountCents = body.amountCents ?? owedCents

  const { data: payout, error } = await supabase.from('payouts').insert({
    partner_id:              partnerId,
    amount_cents:            amountCents,
    currency:                body.currency,
    payout_method:           payoutMethod,
    payout_details_snapshot: partner.payout_details || {},
    note:                    body.note || null
  }).select('*').single()
  if (error) throw error

  // SIMPLIFICATION, flagged rather than silently assumed: every currently-
  // unpaid ledger row is marked settled by THIS payout, regardless of
  // whether amountCents was overridden to something other than the full
  // pending balance. This is correct for the normal case (admin pays
  // exactly what's owed) but means a deliberate partial payment still
  // clears the ledger rather than leaving a remainder outstanding. Fine for
  // a solo-admin, low-volume manual process; revisit if partial payouts
  // become routine.
  if (unpaidLedger.length > 0) {
    const ledgerIds = unpaidLedger.map(l => l.id)
    const { error: settleErr } = await supabase.from('commission_ledger')
      .update({ payout_id: payout.id }).in('id', ledgerIds)
    if (settleErr) console.error('adminRecordPayout ledger settlement:', settleErr.message)
  }

  // The payout already happened in real life (admin sent it before
  // clicking this) — an email failure here must not roll back or hide the
  // recorded payout, only the notification.
  const emailed = await emailService.sendPayoutSent(
    ctx.env, supabase, partner.email, partner.name, amountCents, body.currency
  ).catch(() => false)

  return ctx.json({ success: true, data: payoutRowToCamel(payout), emailed })
}

// ── Public (token-gated): partner views their own current payout details ───

async function getPartnerByToken(ctx) {
  const token = ctx.req.query('token')
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners')
    .select('name, payout_method, payout_details, payout_details_submitted_at')
    .eq('payout_details_token', token)
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  return ctx.json({ success: true, data: partnerRowToCamel(partner) })
}

// ── Public (token-gated): partner submits/updates their payout details ─────

const bankDetailsSchema = z.object({
  payoutMethod:  z.literal('BANK'),
  bankName:      z.string().min(1).max(200),
  accountName:   z.string().min(1).max(200),
  accountNumber: z.string().min(1).max(50)
})
const mobileMoneyDetailsSchema = z.object({
  payoutMethod: z.literal('MOBILE_MONEY'),
  provider:     z.string().min(1).max(100),
  accountName:  z.string().min(1).max(200),
  phoneNumber:  z.string().min(1).max(30)
})
const payoutDetailsSchema = z.discriminatedUnion('payoutMethod', [
  bankDetailsSchema, mobileMoneyDetailsSchema
])

async function submitPayoutDetails(ctx) {
  const token = ctx.req.query('token')
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const body = payoutDetailsSchema.parse(await ctx.req.json())
  const { payoutMethod, ...details } = body
  const supabase = getSupabase(ctx.env)

  const { data, error } = await supabase.from('partners')
    .update({
      payout_method:                payoutMethod,
      payout_details:                details,
      payout_details_submitted_at:  new Date().toISOString(),
      updated_at:                    new Date().toISOString()
    })
    .eq('payout_details_token', token)
    .select('name')
    .maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  return ctx.json({ success: true, message: 'Payout details saved.' })
}

// ── Public (token-gated): partner's own stats dashboard ─────────────────────
// Same token as the payout-details form — one link, two pages. Read-only:
// a partner can see their codes/earnings but never edit pricing or rates.

async function getPartnerDashboard(ctx) {
  const token = ctx.req.query('token')
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners')
    .select(`
      name, commission_rate,
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, created_at),
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, paid_at, created_at)
    `)
    .eq('payout_details_token', token)
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  const ledger = partner.commission_ledger || []
  const codes  = partner.referral_codes || []

  return ctx.json({ success: true, data: {
    name:           partner.name,
    commissionRate: partner.commission_rate,
    referralCodes:  codes.map(referralCodeRowToCamel),
    commissionLedger: ledger.map(commissionLedgerRowToCamel),
    payouts:        (partner.payouts || []).map(payoutRowToCamel),
    stats: {
      totalClicks:      codes.reduce((sum, code) => sum + (code.clicks || 0), 0),
      totalConversions: ledger.length,
      pendingCents:     pendingCents(ledger),
      paidCents:        ledger.filter(l => l.payout_id).reduce((sum, l) => sum + l.commission_amount_cents, 0)
    }
  } })
}

// ── Public: click tracking ──────────────────────────────────────────────────
// Fired by the frontend (useReferralCapture) whenever a ?ref=CODE link is
// visited. Best-effort, high-volume, no sensitive data — an unknown or
// malformed code is a silent no-op, never an error the frontend has to handle.

async function trackClick(ctx) {
  const body = await ctx.req.json().catch(() => ({}))
  const code = String(body.code || '').trim().toUpperCase()
  if (!code) return ctx.json({ success: true })

  const supabase = getSupabase(ctx.env)
  const { error } = await supabase.rpc('increment_referral_code_clicks', { p_code: code })
  if (error) console.error('trackClick:', error.message)
  return ctx.json({ success: true })
}

module.exports = {
  adminCreatePartner, adminListPartners, adminResendPayoutLink, adminRecordPayout,
  adminCreateReferralCode, adminSetReferralCodeActive,
  getPartnerByToken, submitPayoutDetails, getPartnerDashboard, trackClick
}
