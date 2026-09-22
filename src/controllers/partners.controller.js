// Manual-payout partner tracking + referral-code commission ledger, plus
// the admin-facing surface around both (partner CRUD, cycle-based payout
// reporting, referral-code editing, payout-link rotation).
//
// Four audiences hit this controller:
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
const { recentCycles, cycleKey } = require('../lib/cycles')
const {
  partnerRowToCamel, payoutRowToCamel, referralCodeRowToCamel, commissionLedgerRowToCamel,
  camelToSnake, PARTNER_FIELD_MAP
} = require('../lib/mappers')

// Sum of commission_ledger rows not yet attached to a payout — the "owed"
// number both adminListPartners and adminRecordPayout rely on. Kept as one
// function so the two can never compute it differently.
function pendingCents(ledgerRows) {
  return (ledgerRows || []).filter(l => !l.payout_id).reduce((sum, l) => sum + l.commission_amount_cents, 0)
}

// Buckets raw commission_ledger rows into the last `count` twice-monthly
// cycles (see lib/cycles.js) — gross/commission/paid/unpaid totals per
// cycle, so "how much is owed for a specific cycle" is an actual number
// instead of something Jack would have to reconstruct from raw rows.
// Cycles with zero activity still appear (so the current, still-accruing
// cycle always shows even before its first conversion).
function buildCyclesSummary(ledgerRows, count) {
  const cycles = recentCycles(count)
  const byKey = new Map(cycles.map(c => [c.key, {
    grossCents: 0, commissionCents: 0, unpaidCents: 0, paidCents: 0,
    ledgerCount: 0, payoutIds: new Set()
  }]))

  for (const row of ledgerRows || []) {
    const bucket = byKey.get(cycleKey(row.created_at))
    if (!bucket) continue  // older than the window being summarized
    bucket.grossCents      += row.gross_amount_cents
    bucket.commissionCents += row.commission_amount_cents
    bucket.ledgerCount     += 1
    if (row.payout_id) {
      bucket.paidCents += row.commission_amount_cents
      bucket.payoutIds.add(row.payout_id)
    } else {
      bucket.unpaidCents += row.commission_amount_cents
    }
  }

  return cycles.map(c => {
    const b = byKey.get(c.key)
    return { ...c, grossCents: b.grossCents, commissionCents: b.commissionCents,
      unpaidCents: b.unpaidCents, paidCents: b.paidCents,
      ledgerCount: b.ledgerCount, payoutIds: [...b.payoutIds] }
  })
}

// ── Admin: create a partner ────────────────────────────────────────────────
//
// AUDIT FIX (Admin panel pass): dropped the optional `referralCode` field
// this endpoint used to accept and write to partners.referral_code. That
// column (0011) predates the real pricing/attribution mechanism built in
// 0012 (the separate referral_codes table, used everywhere else in this
// file) — 0012's own comment already flagged it as "an optional label for
// now; not wired to pricing yet." It had no input field anywhere in the
// admin UI and was never displayed anywhere either: a schema-supported
// column with a completely dead write path AND a completely dead read
// path, confusable with the real, different "referral code" concept. The
// column itself is left in place (not this file's to drop), just no
// longer written here.

const createPartnerSchema = z.object({
  name:  z.string().min(1).max(200),
  email: z.string().email()
})

async function adminCreatePartner(ctx) {
  const body = createPartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)
  const token = cryptoLib.randomToken(32)

  const { data, error } = await supabase.from('partners').insert({
    name:                 body.name,
    email:                body.email,
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

// ── Admin: update a partner ─────────────────────────────────────────────────
// status/commissionRate close the two gaps flagged in Section 10's audit:
//   - commission_rate (0012) had no write path anywhere; every partner was
//     permanently stuck at the 0.25 column default with no way to
//     negotiate a different rate. Going-forward only — every existing
//     commission_ledger row already carries its own commission_rate
//     snapshot taken at conversion time (see referral.service.js's
//     recordConversion), so changing it here never retroactively changes
//     what's already been earned or owed.
//   - status (0011's partner_status_enum, ACTIVE/PAUSED) had no write path
//     AND, until referral.service.js's isCodeUsable() fix, wasn't even
//     read anywhere — pausing a partner did literally nothing.
// name/email are a further gap closed in the same pass (Admin panel):
// there was no way to fix a typo'd email or name short of a direct DB
// edit. Handled as explicit fields here rather than folded into
// PARTNER_FIELD_MAP/camelToSnake — mappers.js's own comment on that map
// deliberately keeps it to the two simplest, lowest-stakes fields; email
// in particular is how a partner receives every payout-link and
// notification email in this file, so it stays a distinct, visible branch
// here rather than blending into the generic partial-update helper.

const updatePartnerSchema = z.object({
  name:           z.string().min(1).max(200).optional(),
  email:          z.string().email().optional(),
  status:         z.enum(['ACTIVE', 'PAUSED']).optional(),
  // Fraction, not a percentage integer — 0.25 = 25%, matching 0012's
  // commission_rate comment. Bounded 0-1 here at the API boundary; the
  // same bound also exists as a DB-level CHECK (see migration 0015) as a
  // backstop for any future write path that doesn't go through this Zod
  // schema.
  commissionRate: z.number().min(0).max(1).optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one field is required.')

async function adminUpdatePartner(ctx) {
  const partnerId = ctx.req.param('id')
  const body = updatePartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const patch = camelToSnake(body, PARTNER_FIELD_MAP)  // status, commissionRate
  if (body.name !== undefined)  patch.name = body.name
  if (body.email !== undefined) patch.email = body.email
  patch.updated_at = new Date().toISOString()

  const { data, error } = await supabase.from('partners')
    .update(patch).eq('id', partnerId).select('*').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  return ctx.json({ success: true, data: partnerRowToCamel(data) })
}

// ── Admin: list all partners + a light cycle summary + pending balance ─────
// Deliberately does NOT ship the full commission_ledger to the browser here
// (it used to — fetched on every list load and never rendered anywhere).
// The list view only needs enough to answer "who's owed something and how
// much is actually ready to pay right now" — the full ledger (for the
// Conversions tab) lives behind adminGetPartner, fetched only when someone
// opens that partner's detail page.

async function adminListPartners(ctx) {
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase
    .from('partners')
    .select(`
      *,
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, period_start, period_end, paid_at, created_at),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, partner_id, gross_amount_cents, commission_amount_cents, payout_id, created_at)
    `)
    .order('created_at', { ascending: false })
  if (error) throw error

  const partners = data.map(row => {
    const camel = partnerRowToCamel(row)
    const ledger = row.commission_ledger || []
    const cycles = buildCyclesSummary(ledger, 2)  // [current, previous]
    const currentCycle = cycles.find(c => c.isCurrent)

    camel.pendingCommissionCents  = pendingCents(ledger)
    // "Ready to pay" excludes the current, still-accruing cycle — that
    // matches the twice-a-month rhythm: a cycle isn't payable until it's
    // over. Anything unpaid from BEFORE the current cycle (including any
    // older, un-summarized cycles beyond this 2-cycle window) is ready now.
    camel.currentCycleAccruedCents = currentCycle ? currentCycle.unpaidCents : 0
    camel.readyToPayCents          = camel.pendingCommissionCents - camel.currentCycleAccruedCents
    camel.currentCycleLabel        = currentCycle ? currentCycle.label : null
    delete camel.commissionLedger  // never present here — see the select() above; defensive only
    return camel
  })
  return ctx.json({ success: true, data: partners })
}

// ── Admin: single partner detail — full ledger, full payout history, and a
// deeper (12-cycle, ~6 month) rolling cycle breakdown for the drill-down page.

async function adminGetPartner(ctx) {
  const partnerId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase
    .from('partners')
    .select(`
      *,
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, period_start, period_end, paid_at, created_at),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, reverses_ledger_id, reversal_reason, created_at)
    `)
    .eq('id', partnerId)
    .order('paid_at',    { foreignTable: 'payouts',         ascending: false })
    .order('created_at', { foreignTable: 'referral_codes',  ascending: false })
    .order('created_at', { foreignTable: 'commission_ledger', ascending: false })
    .maybeSingle()
  if (error) throw error
  if (!row) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const ledger = row.commission_ledger || []
  const camel = partnerRowToCamel(row)
  camel.pendingCommissionCents = pendingCents(ledger)
  camel.commissionLedger = ledger.map(commissionLedgerRowToCamel)
  camel.cyclesSummary = buildCyclesSummary(ledger, 12)

  return ctx.json({ success: true, data: camel })
}

// ── Admin: re-send a partner's payout-details link (same token) ────────────

async function adminResendPayoutLink(ctx) {
  const partnerId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners').select('name, email, payout_details_token').eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${partner.payout_details_token}`
  const sent = await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, partner.email, partner.name, payoutUrl)
  // AUDIT FIX (feature gap): payout_details_token is deliberately stripped
  // out of partnerRowToCamel everywhere (see mappers.js) so the raw token
  // never round-trips through a general partner-read response — that's
  // still the right default. But that left email as the ONLY delivery
  // channel with zero admin-facing fallback: if Resend bounces, lands in
  // spam, or the address on file is stale, the admin had no way to get the
  // partner their link short of a raw DB query. This route is a narrower,
  // deliberate exception to that rule: it's admin-only (adminOnly
  // middleware), the requesting admin explicitly asked to (re)send THIS
  // partner's link, and that same admin session can already read this
  // partner's actual bank/mobile-money payout_details via adminGetPartner
  // — strictly more sensitive than a rotatable link token. Returning it
  // here doesn't expand what the admin can see, just gives them a copyable
  // fallback for the one thing that's otherwise single-channel.
  return ctx.json({ success: sent, message: sent ? 'Link re-sent.' : 'Email send failed — check logs.', payoutUrl })
}

// ── Admin: ROTATE a partner's payout-details link ───────────────────────────
// Issues a brand-new token and overwrites the old one, so the previous link
// stops working the instant this runs. There was previously no way to
// invalidate a payout link short of a direct DB edit — this link is the
// only thing standing between an email compromise and someone redirecting
// a real future payout, and it never expired or rotated on its own.

async function adminRegeneratePayoutLink(ctx) {
  const partnerId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const newToken = cryptoLib.randomToken(32)

  const { data: partner, error } = await supabase
    .from('partners')
    .update({ payout_details_token: newToken })
    .eq('id', partnerId)
    .select('name, email')
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${newToken}`
  const emailed = await emailService.sendPartnerLinkRegenerated(ctx.env, supabase, partner.email, partner.name, payoutUrl)
    .catch(() => false)

  // AUDIT FIX (feature gap): same admin-facing fallback as adminResendPayoutLink
  // above, and if anything a stronger case here — this is the moment the
  // token is freshly minted, so there's no "existing long-lived secret"
  // concern, only a one-time echo of what this request itself just wrote.
  return ctx.json({ success: true, emailed,
    message: emailed ? 'Link reset — new link emailed.' : 'Link reset, but the notification email failed to send.',
    payoutUrl })
}

// ── Admin: create a referral code for a partner ─────────────────────────────
// Emails the partner their code + dashboard link immediately — this is the
// moment their dashboard actually becomes useful, so it's the natural point
// to send them there rather than at partner-creation time.

const tierPricesSchema = z.object({
  FIX:       z.number().int().positive().optional(),
  BADGE:     z.number().int().positive().optional(),
  FIX_PLAIN: z.number().int().positive().optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one tier price is required.')

const createReferralCodeSchema = z.object({
  code:       z.string().min(2).max(50),
  tierPrices: tierPricesSchema,
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

// ── Admin: update a referral code — active flag AND/OR its pricing/limits ──
// AUDIT FIX (Admin panel pass): previously this endpoint (adminSetReferral-
// CodeActive) could only toggle `active`; changing a tier price or usage
// limit meant deactivating the code and creating an entirely new one —
// losing the original code string (already handed out on flyers, bios,
// etc.) along with its accumulated clicks/uses history. This now edits the
// same row in place. Still deliberately no DELETE and no way to change the
// code string itself — payments.referral_code_id references this row, so
// the identity of a code must stay stable for historical attribution.

const updateReferralCodeSchema = z.object({
  active:      z.boolean().optional(),
  tierPrices:  tierPricesSchema.optional(),
  usageLimit:  z.number().int().positive().nullable().optional(),
  expiresAt:   z.string().datetime().nullable().optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one field is required.')

async function adminUpdateReferralCode(ctx) {
  const codeId = ctx.req.param('codeId')
  const body = updateReferralCodeSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const patch = {}
  if (body.active !== undefined)      patch.active = body.active
  if (body.tierPrices !== undefined)  patch.tier_prices = body.tierPrices
  if (body.usageLimit !== undefined)  patch.usage_limit = body.usageLimit
  if (body.expiresAt !== undefined)   patch.expires_at = body.expiresAt

  const { data, error } = await supabase.from('referral_codes')
    .update(patch).eq('id', codeId).select('*').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Referral code not found.' }, 404)

  return ctx.json({ success: true, data: referralCodeRowToCamel(data) })
}

// ── Admin: record a payout that has ALREADY been sent manually ─────────────
// Two modes:
//   1. CYCLE-SCOPED (periodStart + periodEnd given) — the normal, twice-a-
//      month case. Only unpaid commission_ledger rows earned inside that
//      window are settled; amountCents defaults to just their sum. This is
//      what "how much do I owe for the Sep 1-15 cycle" resolves to.
//   2. AD HOC (no period given) — the original "pay everything currently
//      owed" behavior, preserved for a bonus, a catch-up payment covering
//      multiple stale cycles at once, or any payout with no ledger backing
//      it at all.
// In both modes, amountCents can still be overridden manually (a rounded-up
// transfer, a partial payment) — but note the ledger settlement always marks
// every ledger row IN SCOPE (the whole cycle, or the whole unpaid balance)
// as settled by this payout, regardless of the amount actually entered.
// That's correct for the normal case (admin pays exactly what's shown) but
// means a deliberate partial payment still clears the in-scope rows rather
// than leaving a remainder outstanding — same acknowledged simplification
// as before, just now scoped per-cycle instead of across the partner's
// entire history.
//
// AUDIT FIX (bug — concurrent double-record): the ledger settlement below
// used to be `.update({payout_id}).in('id', ledgerIds)` with NO guard on the
// row's CURRENT payout_id. ledgerIds came from a SELECT taken moments
// earlier, so two overlapping calls for the same partner (a double-click
// before the UI's own `saving` guard kicks in, or two admin tabs/sessions)
// would both read the same unpaid rows and both then unconditionally
// overwrite payout_id on them — the second call's UPDATE silently STEALS
// those ledger rows from the first payout, corrupting which payout actually
// settled what, not just creating a cosmetic duplicate. Every other
// money-moving write in this codebase (payments.controller.js's verify/
// webhook flip, reconcile.service.js's sweep claim) uses an atomic
// UPDATE...WHERE-still-unclaimed...RETURNING specifically to make this
// structurally impossible; this was the one write that didn't. Supabase-js
// has no cross-table transaction here, so a payout row is still inserted
// optimistically (same as before — an admin recording a payout that already
// happened in real life shouldn't get silently rolled back), but the
// settlement itself is now the same atomic claim pattern: `.is('payout_id',
// null)` in the WHERE clause, `.select()` to see exactly which rows this
// call actually won. If a concurrent payout claimed some of them first
// (rare, but no longer silently wrong), and the amount wasn't explicitly
// typed by the admin, the payout's amount_cents is corrected down to what
// it actually settled — so the books never show a payout for commissions
// it didn't really claim — and the owner is alerted, since that only
// happens when two payout-recording calls genuinely overlapped.

const recordPayoutSchema = z.object({
  amountCents:  z.number().int().positive().optional(),
  currency:     z.string().length(3).default('USD'),
  payoutMethod: z.enum(['BANK', 'MOBILE_MONEY']).optional(),
  note:         z.string().max(500).optional(),
  periodStart:  z.string().datetime().optional(),
  periodEnd:    z.string().datetime().optional()
}).refine(b => Boolean(b.periodStart) === Boolean(b.periodEnd),
  'periodStart and periodEnd must be provided together.')

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

  let ledgerQuery = supabase.from('commission_ledger').select('id, commission_amount_cents')
    .eq('partner_id', partnerId).is('payout_id', null)
  if (body.periodStart) ledgerQuery = ledgerQuery.gte('created_at', body.periodStart).lte('created_at', body.periodEnd)
  const { data: unpaidLedger, error: ledgerErr } = await ledgerQuery
  if (ledgerErr) throw ledgerErr

  const owedCents   = unpaidLedger.reduce((sum, l) => sum + l.commission_amount_cents, 0)
  // SECTION 8 AUDIT: reversal rows (refunds/chargebacks) are NEGATIVE ledger
  // entries, so the net owed can now be zero or negative — e.g. a commission
  // already paid out was reversed and nothing new has accrued to net it
  // against. Recording a payout of <= 0 would be nonsense (and negative
  // amounts fail the payouts check constraint); tell the admin instead.
  if (body.amountCents === undefined && owedCents <= 0)
    return ctx.json({ success: false, message: owedCents < 0
      ? `Net owed is negative (${owedCents} cents) because of refund/chargeback reversals — nothing to pay. It will net against this partner's future commission.`
      : 'Nothing owed for this scope.' }, 400)
  const amountCents = body.amountCents ?? owedCents

  const { data: payout, error } = await supabase.from('payouts').insert({
    partner_id:              partnerId,
    amount_cents:            amountCents,
    currency:                body.currency,
    payout_method:           payoutMethod,
    payout_details_snapshot: partner.payout_details || {},
    note:                    body.note || null,
    period_start:            body.periodStart ? body.periodStart.slice(0, 10) : null,
    period_end:              body.periodEnd   ? body.periodEnd.slice(0, 10)   : null
  }).select('*').single()
  if (error) throw error

  let payoutRow = payout
  let racedWithConcurrentPayout = false

  if (unpaidLedger.length > 0) {
    const ledgerIds = unpaidLedger.map(l => l.id)
    // Atomic claim: only settle rows that are STILL unpaid at the moment of
    // this write, not just at the moment of the read above. `.select()`
    // reports exactly which ones this call won.
    const { data: claimed, error: settleErr } = await supabase.from('commission_ledger')
      .update({ payout_id: payout.id })
      .in('id', ledgerIds)
      .is('payout_id', null)
      .select('id, commission_amount_cents')
    if (settleErr) {
      console.error('adminRecordPayout ledger settlement:', settleErr.message)
    } else if ((claimed?.length || 0) < ledgerIds.length) {
      // A concurrent adminRecordPayout call for this same partner claimed
      // some (or all) of these rows first. This payout row already exists
      // and genuinely happened (admin sent real money) — it isn't rolled
      // back — but if its amount wasn't explicitly typed in, it must be
      // corrected to reflect only what THIS payout actually settled, or the
      // books would show commissions counted under two different payouts.
      racedWithConcurrentPayout = true
      const actuallySettledCents = (claimed || []).reduce((sum, l) => sum + l.commission_amount_cents, 0)
      if (body.amountCents == null) {
        const { data: corrected, error: correctErr } = await supabase.from('payouts')
          .update({ amount_cents: actuallySettledCents }).eq('id', payout.id).select('*').maybeSingle()
        if (correctErr) console.error('adminRecordPayout amount correction:', correctErr.message)
        else if (corrected) payoutRow = corrected
      }
      try {
        await emailService.sendOwnerAlert(ctx.env,
          'Payout recording raced a concurrent payout for the same partner',
          `partner: ${partner.name} <${partner.email}>\npayout id: ${payout.id}\n` +
          `ledger rows requested: ${ledgerIds.length}\nledger rows this payout actually claimed: ${claimed?.length || 0}\n` +
          `recorded amount: ${payoutRow.amount_cents} cents\n\n` +
          `Another payout for this partner was recorded at almost the same moment (double-click, or two admin sessions). ` +
          `This payout's amount was ${body.amountCents == null ? 'automatically corrected to' : 'left as manually entered, despite'} ` +
          `only ${claimed?.length || 0} of ${ledgerIds.length} conversion(s) actually being available to settle here — ` +
          `review both payouts for this partner before their next payout run.`
        )
      } catch (_) {}
    }
  }

  // The payout already happened in real life (admin sent it before
  // clicking this) — an email failure here must not roll back or hide the
  // recorded payout, only the notification.
  const emailed = await emailService.sendPayoutSent(
    ctx.env, supabase, partner.email, partner.name, payoutRow.amount_cents, body.currency
  ).catch(() => false)

  return ctx.json({ success: true, data: payoutRowToCamel(payoutRow), emailed, racedWithConcurrentPayout })
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
    .select('name, email')
    .maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  // AUDIT FIX (Admin panel pass): a change here decides where real money
  // goes next, and previously triggered no notification to anyone — not
  // the admin, not even the partner whose own details these are. Both are
  // the tripwire for an unauthorized change (compromised link/inbox);
  // neither blocks the save.
  await Promise.all([
    emailService.sendPayoutDetailsChanged(ctx.env, supabase, data.email, data.name, payoutMethod).catch(() => {}),
    emailService.sendOwnerAlert(ctx.env,
      'Partner payout details changed',
      `partner: ${data.name} <${data.email}>\nmethod: ${payoutMethod}\ntime: ${new Date().toISOString()}\n\nIf this wasn't expected, verify with the partner directly before their next payout.`
    ).catch(() => {})
  ])

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
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, reverses_ledger_id, reversal_reason, created_at),
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, period_start, period_end, paid_at, created_at)
    `)
    .eq('payout_details_token', token)
    // AUDIT FIX (feature gap): these three sub-selects came back in whatever
    // order Postgres felt like — adminGetPartner already orders the same
    // three relations for exactly this reason (a partner-facing "recent
    // activity" list is meaningless out of order). Matching that here too.
    .order('paid_at',    { foreignTable: 'payouts',           ascending: false })
    .order('created_at', { foreignTable: 'referral_codes',    ascending: false })
    .order('created_at', { foreignTable: 'commission_ledger', ascending: false })
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
    // Last 3 cycles (current + 2 prior) — enough for a partner to see
    // "here's what's still accruing" vs. "here's what's queued for the
    // next payout run" without exposing Jack's full 6-month admin view.
    cyclesSummary: buildCyclesSummary(ledger, 3),
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
  adminCreatePartner, adminUpdatePartner, adminListPartners, adminGetPartner,
  adminResendPayoutLink, adminRegeneratePayoutLink, adminRecordPayout,
  adminCreateReferralCode, adminUpdateReferralCode,
  getPartnerByToken, submitPayoutDetails, getPartnerDashboard, trackClick
}
