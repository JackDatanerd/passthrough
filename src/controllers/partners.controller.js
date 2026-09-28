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
const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const emailService = require('../services/email.service')
const { recentCycles, cycleKey } = require('../lib/cycles')
const { logAdminAction } = require('../lib/adminAudit')
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
// Optional refund-window hold (env COMMISSION_HOLD_DAYS, default 0 = off).
// A NON-reversal commission row younger than this many days is "held": it is
// excluded from ready-to-pay and from payouts, so a refund/dispute can still
// land before money leaves. Reversal rows are never held (they must net
// immediately).
function holdDaysFor(env) {
  const n = parseInt(env?.COMMISSION_HOLD_DAYS, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}
function isHeldRow(row, holdDays, now = Date.now()) {
  if (!holdDays || row.payout_id || row.reverses_ledger_id) return false
  return Date.parse(row.created_at) > now - holdDays * 86400000
}
// Unpaid commission that is actually payable now: not in the running cycle
// and not held.
function payableCents(ledgerRows, holdDays) {
  const currentKey = cycleKey(new Date().toISOString())
  return (ledgerRows || []).filter(l => !l.payout_id && cycleKey(l.created_at) !== currentKey && !isHeldRow(l, holdDays))
    .reduce((sum, l) => sum + l.commission_amount_cents, 0)
}
function heldCentsOf(ledgerRows, holdDays) {
  return (ledgerRows || []).filter(l => isHeldRow(l, holdDays)).reduce((sum, l) => sum + l.commission_amount_cents, 0)
}

function buildCyclesSummary(ledgerRows, count, holdDays = 0) {
  const cycles = recentCycles(count)
  const byKey = new Map(cycles.map(c => [c.key, {
    grossCents: 0, commissionCents: 0, unpaidCents: 0, paidCents: 0, heldCents: 0,
    ledgerCount: 0, payoutIds: new Set()
  }]))

  for (const row of ledgerRows || []) {
    const bucket = byKey.get(cycleKey(row.created_at))
    if (!bucket) continue  // older than the window being summarized
    bucket.grossCents      += row.gross_amount_cents
    bucket.commissionCents += row.commission_amount_cents
    // AUDIT FIX (bug): a refund/reversal is a SECOND commission_ledger row
    // (reverses_ledger_id pointing back at the original — see fulfillment.
    // service.js's reverseCommission), with negative gross/commission
    // amounts so the $ totals above net out correctly. This count didn't
    // know the difference: one refunded sale showed as 2 "conversions"
    // instead of net 0/1, on both this cycle breakdown (admin PartnerDetail.
    // jsx) and getPartnerDashboard's totalConversions below (partner-facing
    // PartnerDashboard.jsx). Only an ORIGINAL row is a real conversion.
    if (!row.reverses_ledger_id) bucket.ledgerCount += 1
    if (row.payout_id) {
      bucket.paidCents += row.commission_amount_cents
      bucket.payoutIds.add(row.payout_id)
    } else {
      bucket.unpaidCents += row.commission_amount_cents
      if (isHeldRow(row, holdDays)) bucket.heldCents += row.commission_amount_cents
    }
  }

  return cycles.map(c => {
    const b = byKey.get(c.key)
    return { ...c, grossCents: b.grossCents, commissionCents: b.commissionCents,
      unpaidCents: b.unpaidCents, paidCents: b.paidCents, heldCents: b.heldCents,
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
  name:  z.string().trim().min(1).max(200),
  email: z.string().email()
})

// Section 10 audit: partners.email had no uniqueness guarantee — no DB
// constraint (see migration 0043) and no check in either write path below —
// unlike users.email / referral_codes.code. It is the sole channel for every
// payout link, payout confirmation and referral-code notice a partner gets,
// so two rows sharing one inbox made those indistinguishable. Same pattern as
// updateEmail() for users: a proactive check for a clear 400 in the common
// case, with the unique index as the backstop for a race (which surfaces
// through errorHandler.js's generic 23505 branch).
async function emailUsedByAnotherPartner(supabase, email, excludePartnerId) {
  // .limit(1) + array check, not .maybeSingle(): that THROWS on >1 match,
  // which is exactly the legacy-duplicate case this must handle cleanly.
  // SECTION 3/4 AUDIT FIX (bug): ilike treats `_` and `%` in the pattern as
  // wildcards, but this is an EXACT case-insensitive match (what
  // idx_partners_email_lower_unique enforces). `_` is extremely common in
  // real addresses, so john.smith@x.com wrongly collided with an existing
  // john_smith@x.com (and vice versa) and was rejected as a duplicate that
  // the unique index would never have flagged. Escape the LIKE
  // metacharacters (backslash is Postgres's default LIKE escape) so only a
  // genuine case-insensitive equal matches.
  const exact = String(email).replace(/[\\%_]/g, '\\$&')
  let q = supabase.from('partners').select('id').ilike('email', exact).limit(1)
  if (excludePartnerId) q = q.neq('id', excludePartnerId)
  const { data, error } = await q
  if (error) throw error
  return (data || []).length > 0
}

async function adminCreatePartner(ctx) {
  const body = createPartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  if (await emailUsedByAnotherPartner(supabase, body.email))
    return ctx.json({ success: false, message: 'A partner with that email address already exists.' }, 400)

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

  await logAdminAction(ctx, supabase, 'partner.create', 'partner', data.id, { commissionRate: data.commission_rate })

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
  name:           z.string().trim().min(1).max(200).optional(),
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

  // AUDIT FIX (feature gap): need the OLD email AND status before they're
  // overwritten, so both notifications below have something to compare
  // against. Best-effort — if this read fails, fall through to the update
  // exactly as before, just without either notification.
  const { data: before } = await supabase.from('partners').select('email, status, commission_rate').eq('id', partnerId).maybeSingle()

  // Section 10 audit: see emailUsedByAnotherPartner above. Only queried when
  // the address actually changes (case-insensitively), not on every save.
  if (body.email !== undefined && (!before?.email || body.email.toLowerCase() !== before.email.toLowerCase())) {
    if (await emailUsedByAnotherPartner(supabase, body.email, partnerId))
      return ctx.json({ success: false, message: 'A partner with that email address already exists.' }, 400)
  }

  const patch = camelToSnake(body, PARTNER_FIELD_MAP)  // status, commissionRate
  if (body.name !== undefined)  patch.name = body.name
  if (body.email !== undefined) patch.email = body.email
  patch.updated_at = new Date().toISOString()

  // A changed email means the OLD address may still hold the bearer link to
  // the partner's dashboard and payout destination. Rotate the token in the
  // same write so that link dies with the address change; the new address
  // receives the fresh link below.
  const emailChanging = body.email !== undefined && !!before?.email && before.email !== body.email
  const rotatedToken  = emailChanging ? cryptoLib.randomToken(32) : null
  if (rotatedToken) patch.payout_details_token = rotatedToken
  const rateChanging = body.commissionRate !== undefined && before?.commission_rate != null &&
    Number(before.commission_rate) !== body.commissionRate

  const { data, error } = await supabase.from('partners')
    .update(patch).eq('id', partnerId).select('*').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  // AUDIT FIX (feature gap): submitPayoutDetails already treats a
  // payout-details change as a tripwire moment worth notifying both the
  // partner and the owner about — this is that same treatment for the one
  // change that's arguably higher-stakes: partner.email is the sole channel
  // for every future payout link, payout-sent confirmation, and
  // referral-code notification, so a typo or a compromised admin session
  // silently redirecting (or killing) all future partner comms previously
  // left no paper trail at all. Best-effort, like every other notification
  // in this file — never blocks or fails the save itself.
  if (rotatedToken) {
    await emailService.sendPartnerLinkRegenerated(ctx.env, supabase, data.email, data.name,
      `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${rotatedToken}`).catch(() => {})
  }
  if (rateChanging) {
    await emailService.sendPartnerRateChanged(ctx.env, supabase, data.email, data.name,
      before.commission_rate, data.commission_rate).catch(() => {})
  }
  if (body.email !== undefined && before?.email && before.email !== data.email) {
    await Promise.all([
      emailService.sendPartnerEmailChanged(ctx.env, supabase, before.email, data.name, before.email, data.email).catch(() => {}),
      emailService.sendPartnerEmailChanged(ctx.env, supabase, data.email,  data.name, before.email, data.email).catch(() => {}),
      // AUDIT FIX (Section 3/4 re-audit, bug): dedupeKey: partnerId —
      // sendOwnerAlert's 10-minute dedupe is keyed on subject alone unless a
      // dedupeKey is passed, and this subject is a fixed string shared by
      // every partner's email change. Without this, changing TWO different
      // partners' emails within the same 10-minute window (routine admin
      // cleanup, or the exact fraud pattern this alert exists to catch)
      // meant only the first one actually emailed the owner.
      emailService.sendOwnerAlert(ctx.env,
        'Partner email changed',
        `partner: ${data.name}\nold email: ${before.email}\nnew email: ${data.email}\ntime: ${new Date().toISOString()}\n\n` +
        `If this wasn't expected, verify with the partner directly before their next payout or referral-code notification.`,
        { dedupeKey: partnerId }
      ).catch(() => {})
    ])
  }

  // AUDIT FIX (feature gap): status (ACTIVE/PAUSED) was the one
  // account-affecting change in this endpoint with no notification at all —
  // a paused partner previously found out only by noticing their commission
  // had stopped, or by happening to check their own dashboard (which does
  // show a banner — see PartnerDashboard.jsx). Silence here cuts both ways:
  // it's not just unhelpful to a partner paused for a legitimate reason,
  // it's also a blind spot symmetric to the email-change case above — a
  // compromised or careless admin session could quietly cut off a partner's
  // referral links and nobody, partner or owner, would have a paper trail.
  // Best-effort, like every other notification in this file — never blocks
  // or fails the save itself.
  if (body.status !== undefined && before?.status && before.status !== data.status) {
    await Promise.all([
      emailService.sendPartnerStatusChanged(ctx.env, supabase, data.email, data.name, data.status).catch(() => {}),
      // AUDIT FIX (Section 3/4 re-audit, bug): dedupeKey: partnerId — same
      // fix as the email-changed alert above. The subject here varies by
      // transition (ACTIVE -> PAUSED vs PAUSED -> ACTIVE), so two DIFFERENT
      // partners could still collide if both underwent the identical
      // transition in the same window; scoping to partnerId closes that too.
      emailService.sendOwnerAlert(ctx.env,
        `Partner status changed: ${before.status} -> ${data.status}`,
        `partner: ${data.name}\nemail: ${data.email}\nold status: ${before.status}\nnew status: ${data.status}\ntime: ${new Date().toISOString()}`,
        { dedupeKey: partnerId }
      ).catch(() => {})
    ])
  }

  // FEATURE GAP CLOSED (Section 12 audit): the email/status changes just
  // above already trigger a best-effort owner-alert EMAIL — real, but not
  // queryable, and easy to lose in an inbox. This adds the same durable,
  // queryable record every leads-admin action already gets (see
  // employer-leads.controller.js). Field NAMES and status values only,
  // never the actual email addresses (see lib/adminAudit.js's own rule).
  if (rateChanging ||
      (body.email !== undefined && before?.email && before.email !== data.email) ||
      (body.status !== undefined && before?.status && before.status !== data.status)) {
    await logAdminAction(ctx, supabase, 'partner.update', 'partner', partnerId, {
      emailChanged: body.email !== undefined && before?.email !== data.email,
      ...(rotatedToken ? { payoutLinkRotated: true } : {}),
      ...(rateChanging ? { rateFrom: Number(before.commission_rate), rateTo: Number(data.commission_rate) } : {}),
      ...(body.status !== undefined && before?.status !== data.status
        ? { statusFrom: before.status, statusTo: data.status } : {})
    })
  }

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
      commission_ledger(id, partner_id, gross_amount_cents, commission_amount_cents, payout_id, reverses_ledger_id, created_at)
    `)
    .order('created_at', { ascending: false })
  if (error) throw error

  const partners = data.map(row => {
    const camel = partnerRowToCamel(row)
    const ledger = row.commission_ledger || []
    const holdDays = holdDaysFor(ctx.env)
    const cycles = buildCyclesSummary(ledger, 2, holdDays)  // [current, previous]
    const currentCycle = cycles.find(cyc => cyc.isCurrent)

    camel.pendingCommissionCents  = pendingCents(ledger)
    // "Ready to pay" excludes the current, still-accruing cycle — that
    // matches the twice-a-month rhythm: a cycle isn't payable until it's
    // over. Anything unpaid from BEFORE the current cycle (including any
    // older, un-summarized cycles beyond this 2-cycle window) is ready now.
    camel.currentCycleAccruedCents = currentCycle ? currentCycle.unpaidCents : 0
    camel.readyToPayCents          = payableCents(ledger, holdDays)
    camel.heldCents                = heldCentsOf(ledger, holdDays)
    camel.currentCycleLabel        = currentCycle ? currentCycle.label : null
    // AUDIT FIX (Section 3/4 pass, bug): commission_ledger has no currency
    // column of its own (unlike payouts, which does and is threaded through
    // correctly elsewhere) — every commission-derived figure above was
    // rendered via AdminPartners.jsx's formatCents(cents) with NO currency
    // argument, silently defaulting to a hardcoded "$"/USD label regardless
    // of the platform's actual configured currency. There's only one
    // currency for the whole platform (env.PAYSTACK_CURRENCY), so attaching
    // it per-row here (mirroring how payouts already carry their own
    // `currency`) is what the frontend needs to stop assuming USD.
    camel.currency                 = ctx.env.PAYSTACK_CURRENCY || c.CURRENCY
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
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, settled_commission_cents, period_start, period_end, paid_at, created_at, payout_details_snapshot),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, reverses_ledger_id, reversal_reason, created_at)
    `)
    // AUDIT FIX (feature gap): adminRecordPayout writes payout_details_snapshot
    // — a copy of the partner's bank/mobile-money details AT THE MOMENT a
    // specific payout was recorded — precisely so a later account-details
    // change (which this file already treats as a fraud signal: see
    // submitPayoutDetails' and adminUpdatePartner's security-alert emails)
    // doesn't erase the record of what account an already-paid payout
    // actually went to. It was captured on every payout but never selected
    // back anywhere, admin included — this is the one place it should be:
    // admin-only, alongside the payout it belongs to, never on the
    // partner-facing getPartnerDashboard below (which intentionally never
    // exposes bank/mobile-money details at all, current or historical).
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
  const holdDays = holdDaysFor(ctx.env)
  camel.cyclesSummary = buildCyclesSummary(ledger, 12, holdDays)
  camel.olderUnpaidCents = camel.pendingCommissionCents - camel.cyclesSummary.reduce((sum, cyc) => sum + cyc.unpaidCents, 0)
  camel.readyToPayCents = payableCents(ledger, holdDays)
  camel.heldCents = heldCentsOf(ledger, holdDays)
  camel.holdDays = holdDays
  // AUDIT FIX (Section 3/4 pass, bug): see the matching fix in
  // adminListPartners above — same currency-drift gap, same fix.
  camel.currency = ctx.env.PAYSTACK_CURRENCY || c.CURRENCY

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

  // FEATURE GAP CLOSED (Section 12 audit): this route's own comment above
  // calls this link "the only thing standing between an email compromise and
  // someone redirecting a real future payout" — exactly the kind of action
  // that should leave a durable trace of which admin triggered it and when,
  // and until now didn't, anywhere.
  await logAdminAction(ctx, supabase, 'partner.payout_link_regenerated', 'partner', partnerId, { emailed })

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
  // Codes travel in URLs (?ref=CODE), so restrict to characters that survive
  // a link untouched.
  code:       z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, numbers, hyphens and underscores.'),
  tierPrices: tierPricesSchema,
  usageLimit: z.number().int().positive().optional(),
  expiresAt:  z.string().datetime().optional().refine(v => !v || Date.parse(v) > Date.now(), 'Expiry must be in the future.')
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

  await logAdminAction(ctx, supabase, 'partner.referral_code_created', 'referral_code', codeRow.id, {
    partnerId, code: codeRow.code, tierPrices: codeRow.tier_prices, usageLimit: codeRow.usage_limit, expiresAt: codeRow.expires_at
  })

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
    .refine(v => !v || Date.parse(v) > Date.now(), 'Expiry must be in the future.')
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

  await logAdminAction(ctx, supabase, 'partner.referral_code_updated', 'referral_code', codeId, {
    partnerId: data.partner_id, code: data.code, changed: Object.keys(patch)
  })

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

// AUDIT FIX (bug): `currency` used to default to a hardcoded 'USD' here —
// the one money-shaped field in this file that DIDN'T derive from the
// platform's actual configured currency (env.PAYSTACK_CURRENCY), unlike
// adminListPartners/adminGetPartner/getPartnerDashboard, which all
// explicitly attach it for this exact reason. On a non-USD deployment, any
// caller of this endpoint that omits `currency` — a future admin surface,
// a script, anything other than the one frontend page that currently knows
// to work around this by always sending partner.currency explicitly —
// would silently record a payout mislabeled as USD, contaminating the
// books. `currency` is now optional here; the server itself resolves the
// real default in adminRecordPayout, the same way the rest of this file does.
const recordPayoutSchema = z.object({
  amountCents:  z.number().int().positive().optional(),
  currency:     z.string().length(3).optional(),
  payoutMethod: z.enum(['BANK', 'MOBILE_MONEY']).optional(),
  note:         z.string().trim().max(500).optional(),
  // Required (with a note) when amountCents differs from the commission the
  // payout settles — see the check in adminRecordPayout.
  acknowledgeDifference: z.boolean().optional(),
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
  // Refund-window hold (COMMISSION_HOLD_DAYS): young commission rows stay
  // unpaid; reversal rows always settle.
  const holdDays = holdDaysFor(ctx.env)
  if (holdDays) {
    const cutoff = new Date(Date.now() - holdDays * 86400000).toISOString()
    ledgerQuery = ledgerQuery.or(`reverses_ledger_id.not.is.null,created_at.lte.${cutoff}`)
  }
  const { data: unpaidLedger, error: ledgerErr } = await ledgerQuery
  if (ledgerErr) throw ledgerErr

  const owedCents   = unpaidLedger.reduce((sum, l) => sum + l.commission_amount_cents, 0)
  // SECTION 8 AUDIT: reversal rows (refunds/chargebacks) are NEGATIVE ledger
  // entries, so the net owed can now be zero or negative — e.g. a commission
  // already paid out was reversed and nothing new has accrued to net it
  // against. Recording a payout of <= 0 would be nonsense; tell the admin
  // instead.
  // AUDIT FIX (Section 9/10 pass — comment correction): this used to say
  // "and negative amounts fail the payouts check constraint" — no such
  // constraint existed anywhere in the schema until
  // 0031_payment_sweep_index_and_amount_checks.sql added one. Before that,
  // the ONLY thing stopping a negative `amountCents` from reaching the
  // insert below was recordPayoutSchema's `z.number().int().positive()`
  // above (which does work, so this was never actually exploitable) — but
  // the comment claimed a DB-level backstop that didn't exist, which is
  // exactly the kind of false confidence that survives a refactor of the
  // Zod schema and quietly stops meaning anything. Both layers are real now.
  if (body.amountCents === undefined && owedCents <= 0)
    return ctx.json({ success: false, message: owedCents < 0
      ? `Net owed is negative (${owedCents} cents) because of refund/chargeback reversals — nothing to pay. It will net against this partner's future commission.`
      : 'Nothing owed for this scope.' }, 400)
  const amountCents = body.amountCents ?? owedCents

  // Paying a different amount than the commission being settled used to be
  // silent: every in-scope ledger row is marked paid regardless, so an
  // underpayment vanished from the books and an overpayment left no trace.
  // Now the admin must acknowledge it and say why (the note is kept).
  if (amountCents !== owedCents && !(body.acknowledgeDifference && body.note)) {
    return ctx.json({ success: false, code: 'AMOUNT_DIFFERS',
      message: `Amount (${amountCents}) differs from the commission this payout settles (${owedCents}). ` +
        `Confirm the difference and add a note explaining it.` }, 400)
  }
  const currency = body.currency || ctx.env.PAYSTACK_CURRENCY || c.CURRENCY

  const { data: payout, error } = await supabase.from('payouts').insert({
    partner_id:              partnerId,
    amount_cents:            amountCents,
    currency,
    payout_method:           payoutMethod,
    payout_details_snapshot: partner.payout_details || {},
    settled_commission_cents: owedCents,
    note:                    body.note || null,
    period_start:            body.periodStart ? body.periodStart.slice(0, 10) : null,
    period_end:              body.periodEnd   ? body.periodEnd.slice(0, 10)   : null
  }).select('*').single()
  if (error) throw error

  let payoutRow = payout
  let racedWithConcurrentPayout = false
  let ledgerSettlementFailed = false

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
      // AUDIT FIX (bug): this used to be console.error only, with the
      // function still returning success:true and a payout row that CLAIMS
      // these commissions were settled. They weren't — payout_id is still
      // null on every one of them, so they're still "unpaid" and will be
      // pulled into this partner's NEXT payout run too, double-counting
      // real money the admin already sent once. The payout row itself
      // isn't rolled back (it genuinely happened), but unlike the "raced"
      // branch below this failure mode had no owner alert at all.
      console.error('adminRecordPayout ledger settlement:', settleErr.message)
      ledgerSettlementFailed = true
      try {
        // AUDIT FIX (Section 3/4 re-audit, bug): dedupeKey: partnerId — this
        // subject is a fixed string shared across every partner, so without
        // a per-partner dedupeKey, a ledger-settlement failure on a SECOND
        // partner's payout inside the same 10-minute window (a plausible DB
        // blip hitting an admin's whole payout-run session) would silently
        // never reach the owner — exactly the "books may be wrong" case this
        // alert exists for.
        await emailService.sendOwnerAlert(ctx.env,
          'Payout recorded but commission-ledger settlement failed — books may be wrong',
          `partner: ${partner.name} <${partner.email}>\npayout id: ${payout.id}\namount recorded: ${payoutRow.amount_cents} cents\n` +
          `ledger rows this payout was supposed to settle: ${ledgerIds.length}\nerror: ${settleErr.message}\n\n` +
          `The payout row was created (real money was already sent), but marking these commission_ledger rows ` +
          `as paid failed — they still show as UNPAID and may be pulled into a future payout for this partner, ` +
          `double-counting this money. Check commission_ledger for partner_id=${partnerId} with payout_id null ` +
          `and created before this payout, and settle them by hand if this payout already covers them.`,
          { dedupeKey: partnerId }
        )
      } catch (_) {}
    } else if ((claimed?.length || 0) < ledgerIds.length) {
      // A concurrent adminRecordPayout call for this same partner claimed
      // some (or all) of these rows first. This payout row already exists
      // and genuinely happened (admin sent real money) — it isn't rolled
      // back — but if its amount wasn't explicitly typed in, it must be
      // corrected to reflect only what THIS payout actually settled, or the
      // books would show commissions counted under two different payouts.
      racedWithConcurrentPayout = true
      const actuallySettledCents = (claimed || []).reduce((sum, l) => sum + l.commission_amount_cents, 0)
      // One update carries both the true settled figure and (when the amount
      // was auto-computed) the corrected amount.
      const settledPatch = { settled_commission_cents: actuallySettledCents }
      if (body.amountCents == null) {
        settledPatch.amount_cents = actuallySettledCents
      }
      {
        // Note (Section 9/10 pass): claimed rows can include unpaid reversal
        // rows (negative commission_amount_cents — see fulfillment.service.js),
        // so actuallySettledCents can in theory come out <= 0 here even though
        // the pre-check earlier required owedCents > 0 at READ time — that's
        // exactly the race this whole branch exists to handle. If it does,
        // 0031's payouts_amount_cents_nonnegative constraint will reject this
        // update; correctErr below already logs and falls through without
        // throwing, so payoutRow just keeps its original (now-known-wrong)
        // amount and the owner alert further down still fires either way.
        const { data: corrected, error: correctErr } = await supabase.from('payouts')
          .update(settledPatch).eq('id', payout.id).select('*').maybeSingle()
        if (correctErr) console.error('adminRecordPayout amount correction:', correctErr.message)
        else if (corrected) payoutRow = corrected
      }
      try {
        // AUDIT FIX (Section 3/4 re-audit, bug): dedupeKey: partnerId — same
        // fix as the ledger-settlement-failure alert above. Low-likelihood
        // across different partners, but a busy multi-partner payout
        // session is exactly when it'd matter most.
        await emailService.sendOwnerAlert(ctx.env,
          'Payout recording raced a concurrent payout for the same partner',
          `partner: ${partner.name} <${partner.email}>\npayout id: ${payout.id}\n` +
          `ledger rows requested: ${ledgerIds.length}\nledger rows this payout actually claimed: ${claimed?.length || 0}\n` +
          `recorded amount: ${payoutRow.amount_cents} cents\n\n` +
          `Another payout for this partner was recorded at almost the same moment (double-click, or two admin sessions). ` +
          `This payout's amount was ${body.amountCents == null ? 'automatically corrected to' : 'left as manually entered, despite'} ` +
          `only ${claimed?.length || 0} of ${ledgerIds.length} conversion(s) actually being available to settle here — ` +
          `review both payouts for this partner before their next payout run.`,
          { dedupeKey: partnerId }
        )
      } catch (_) {}
    }
  }

  // The payout already happened in real life (admin sent it before
  // clicking this) — an email failure here must not roll back or hide the
  // recorded payout, only the notification.
  const emailed = await emailService.sendPayoutSent(
    ctx.env, supabase, partner.email, partner.name, payoutRow.amount_cents, payoutRow.currency
  ).catch(() => false)

  // FEATURE GAP CLOSED (Section 12 audit): recording a payout moves real
  // money and, unlike the two error paths above (settlement failure, race —
  // both already owner-alerted), the ROUTINE, successful case left no
  // record anywhere of which admin recorded it. amountCents/currency only —
  // no payout method/bank details, which already live on the payout row
  // itself and are the more sensitive of the two.
  await logAdminAction(ctx, supabase, 'partner.payout_recorded', 'payout', payoutRow.id, {
    partnerId, amountCents: payoutRow.amount_cents, currency: payoutRow.currency,
    racedWithConcurrentPayout, ledgerSettlementFailed,
    settledCommissionCents: payoutRow.settled_commission_cents ?? owedCents,
    amountDiffers: payoutRow.amount_cents !== (payoutRow.settled_commission_cents ?? owedCents)
  })

  return ctx.json({ success: true, data: payoutRowToCamel(payoutRow), emailed, racedWithConcurrentPayout, ledgerSettlementFailed })
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
  bankName:      z.string().trim().min(1).max(200),
  accountName:   z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().min(1).max(50)
})
const mobileMoneyDetailsSchema = z.object({
  payoutMethod: z.literal('MOBILE_MONEY'),
  provider:     z.string().trim().min(1).max(100),
  accountName:  z.string().trim().min(1).max(200),
  phoneNumber:  z.string().trim().min(1).max(30)
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
    // AUDIT FIX (Section 3/4 re-audit, bug): dedupeKey: token — this is the
    // subject this whole feature was built around ("the tripwire for an
    // unauthorized change"), and it's a fixed string for every partner.
    // Without a per-partner dedupeKey, a compromised inbox/link submitting
    // fraudulent changes for TWO different partners within the same
    // 10-minute window would only ever alert the owner about the first one
    // — the exact scenario this notification exists to catch. `token` is
    // already in scope and unique per partner, so no extra query is needed.
    emailService.sendOwnerAlert(ctx.env,
      'Partner payout details changed',
      `partner: ${data.name} <${data.email}>\nmethod: ${payoutMethod}\ntime: ${new Date().toISOString()}\n\nIf this wasn't expected, verify with the partner directly before their next payout.`,
      { dedupeKey: token }
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
      name, commission_rate, status,
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

  // AUDIT FIX (Section 3/4 re-audit, feature gap + minor data-exposure bug):
  // this response has always fetched and shipped the FULL commission ledger
  // to the browser — but PartnerDashboard.jsx never rendered it, only the
  // aggregates (stats/cyclesSummary) computed from it below. The admin side
  // has a full per-conversion list (PartnerDetail.jsx's ConversionsTab, fed
  // by this exact same table) — a partner had no equivalent way to see WHICH
  // referrals converted, only totals. The commissionLedgerRowToCamel shape
  // used for the admin view also isn't right to hand a partner as-is: it
  // carries paymentId and partnerId, two internal ids with no partner-facing
  // purpose that this endpoint had no reason to disclose (this is the one
  // partner-facing endpoint in the file that's otherwise deliberately
  // careful about this — see the "never exposes bank/mobile-money details"
  // note below on payout_details_snapshot). referralCodeId is resolved to
  // the actual code string here instead — useful for a partner running more
  // than one code to see which one a given conversion came through — rather
  // than exposed as a raw id with nothing to look it up against.
  const holdDays = holdDaysFor(ctx.env)
  const dashCycles = buildCyclesSummary(ledger, 3, holdDays)
  const codeTextById = new Map(codes.map(row => [row.id, row.code]))
  // AUDIT FIX (Section 3/4 re-audit, feature gap): this used to map and ship
  // EVERY row in `ledger` — the partner's entire, ever-growing conversion
  // history, no bound at all — into a plain, un-paginated list the frontend
  // then rendered in full (PartnerDashboard.jsx's "Recent conversions"
  // list). For a partner with a long history that's an unbounded response
  // payload and an unbounded DOM on every dashboard load, which is exactly
  // the cost adminListPartners' own comment shows this codebase already
  // knows to avoid ("Deliberately does NOT ship the full commission_ledger
  // to the browser") — just not applied here. `ledger` (the full, unsliced
  // array) is still what stats/cyclesSummary below are computed from, since
  // those totals are genuinely cumulative; only the per-row list a partner
  // actually scrolls through is capped, matching what the UI already calls
  // it — "Recent conversions," not "every conversion ever." `ledger` is
  // already ordered newest-first (see the query's own .order() above), so
  // this is exactly the most recent CONVERSIONS_LIST_LIMIT.
  const CONVERSIONS_LIST_LIMIT = 50
  const conversions = ledger.slice(0, CONVERSIONS_LIST_LIMIT).map(row => ({
    id:                    row.id,
    code:                  codeTextById.get(row.referral_code_id) || null,
    grossAmountCents:      row.gross_amount_cents,
    commissionRate:        row.commission_rate == null ? null : Number(row.commission_rate),
    commissionAmountCents: row.commission_amount_cents,
    paid:                  !!row.payout_id,
    // A reversal is a NEGATIVE row undoing an earlier conversion (refund /
    // lost dispute) — see referral.service.js's reverseCommission.
    isReversal:            !!row.reverses_ledger_id,
    reversalReason:        row.reversal_reason ?? null,
    createdAt:             row.created_at
  }))

  return ctx.json({ success: true, data: {
    name:           partner.name,
    commissionRate: partner.commission_rate,
    // AUDIT FIX (Section 3/4 pass, bug): getPartnerDashboard never selected
    // (let alone returned) the partner's own status, so PartnerDashboard.jsx
    // had no way to know a PAUSED partner is paused. isCodeLive there mirrors
    // isCodeUsable (referral.service.js)'s active/expiry/usage-limit checks —
    // but not its fourth check, `partners.status !== 'ACTIVE'`, because this
    // response never carried the data needed to check it. A paused partner's
    // own dashboard showed every code as fully live ("Anyone who visits your
    // link gets the discount automatically") when in fact isCodeUsable had
    // already silently zeroed every one of them out server-side the moment
    // they were paused — the exact failure mode isCodeLive's own comment says
    // it exists to prevent, just for the one cause it didn't check.
    active:         partner.status === 'ACTIVE',
    // Single platform-wide currency (env.PAYSTACK_CURRENCY) — see the matching
    // fix in adminListPartners/adminGetPartner above. Without this,
    // PartnerDashboard.jsx's Pending/Paid stats and per-tier prices always
    // rendered as USD regardless of what's actually configured.
    currency:       ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
    referralCodes:  codes.map(referralCodeRowToCamel),
    conversions,
    // So the frontend can say "showing the most recent 50 of 214" instead of
    // silently looking complete when it isn't.
    conversionsTotal: ledger.length,
    payouts:        (partner.payouts || []).map(payoutRowToCamel),
    // Last 3 cycles (current + 2 prior) — enough for a partner to see
    // "here's what's still accruing" vs. "here's what's queued for the
    // next payout run" without exposing Jack's full 6-month admin view.
    cyclesSummary: dashCycles,
    olderUnpaidCents: pendingCents(ledger) - dashCycles.reduce((sum, cyc) => sum + cyc.unpaidCents, 0),
    holdDays,
    stats: {
      totalClicks:      codes.reduce((sum, code) => sum + (code.clicks || 0), 0),
      // AUDIT FIX (bug): ledger.length counted refund/reversal rows as
      // additional conversions (see buildCyclesSummary's matching fix,
      // above) — a refunded sale showed as 2 conversions here instead of
      // net 0/1. Only rows that AREN'T themselves a reversal are real sales.
      totalConversions: ledger.filter(l => !l.reverses_ledger_id).length,
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
  if (!code || code.length > 50) return ctx.json({ success: true })

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
