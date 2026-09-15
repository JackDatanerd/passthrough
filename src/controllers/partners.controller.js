// Manual-payout partner tracking. No automated disbursement — an admin
// sends money themselves outside this system, then records what/where via
// adminRecordPayout, which stamps a PAID row and emails the partner.
//
// Two audiences hit this controller:
//   - The ADMIN (Jack) — gated by middleware/adminOnly.js.
//   - The PARTNER — no login system for them yet; they're identified by a
//     long random token mailed to them (payout_details_token), passed as
//     ?token=... on the two public endpoints below.

const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const emailService = require('../services/email.service')
const { partnerRowToCamel, payoutRowToCamel } = require('../lib/mappers')

// ── Admin: create a partner ────────────────────────────────────────────────
// Generates their payout-details token and emails them the self-serve link
// immediately — "a UI for submitting the details" starts here.

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
  // fails (e.g. transient Resend error); admin can resend the link manually
  // via adminGetPayoutLink below.
  await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, body.email, body.name, payoutUrl)
    .catch(() => {})

  return ctx.json({ success: true, data: partnerRowToCamel(data) })
}

// ── Admin: list all partners + their payout history ────────────────────────
// This is "a way admin can reach the details" — payoutDetails comes back in
// full (bank/mobile money info) so Jack can actually go send the money.

async function adminListPartners(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase
    .from('partners')
    .select('*, payouts(id, partner_id, amount_cents, currency, payout_method, status, note, paid_at, created_at)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return ctx.json({ success: true, data: data.map(partnerRowToCamel) })
}

// ── Admin: re-send / re-fetch a partner's payout-details link ──────────────
// For when the original email gets lost — regenerates nothing, just resends
// the existing token so old links a partner may have saved keep working.

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

// ── Admin: record a payout that has ALREADY been sent manually ─────────────
// This is the "button I mark, which also emails them" step. It captures the
// amount and payout method at the moment of recording — it does not compute
// anything automatically, since there's no automated commission ledger yet
// (see the growth-strategy build scope for that future piece).

const recordPayoutSchema = z.object({
  amountCents:  z.number().int().positive(),
  currency:     z.string().length(3).default('USD'),
  // Defaults to whatever the partner has on file; only needed if paying
  // through a different method than what they submitted.
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

  const { data: payout, error } = await supabase.from('payouts').insert({
    partner_id:              partnerId,
    amount_cents:            body.amountCents,
    currency:                body.currency,
    payout_method:           payoutMethod,
    payout_details_snapshot: partner.payout_details || {},
    note:                    body.note || null
  }).select('*').single()
  if (error) throw error

  // The payout already happened in real life (admin sent it before
  // clicking this) — an email failure here must not roll back or hide the
  // recorded payout, only the notification.
  const emailed = await emailService.sendPayoutSent(
    ctx.env, supabase, partner.email, partner.name, body.amountCents, body.currency
  ).catch(() => false)

  return ctx.json({ success: true, data: payoutRowToCamel(payout), emailed })
}

// ── Public (token-gated): partner views their own current details ──────────

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
// The two shapes are genuinely different (bank vs. mobile money), so this
// is a discriminated union on payoutMethod rather than one loose schema.

const bankDetailsSchema = z.object({
  payoutMethod:  z.literal('BANK'),
  bankName:      z.string().min(1).max(200),
  accountName:   z.string().min(1).max(200),
  accountNumber: z.string().min(1).max(50)
})
const mobileMoneyDetailsSchema = z.object({
  payoutMethod: z.literal('MOBILE_MONEY'),
  provider:     z.string().min(1).max(100),  // e.g. M-Pesa, MTN MoMo
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

module.exports = {
  adminCreatePartner, adminListPartners, adminResendPayoutLink, adminRecordPayout,
  getPartnerByToken, submitPayoutDetails
}
