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
const { verifyTurnstile } = require('../lib/turnstile')
const { clientIp } = require('../lib/clientIp')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { lookupCode, isCodeUsable } = require('../services/referral.service')
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
// A commission on a payment that is currently DISPUTED (a chargeback is open) is
// held regardless of the age window: if the dispute is lost the sale is reversed
// and the commission clawed back, so paying it out first just creates a debt.
// Needs the ledger select to embed `payments(status)`.
function isHeldRow(row, holdDays, now = Date.now()) {
  if (row.payout_id || row.reverses_ledger_id) return false
  if (row.payments?.status === 'DISPUTED') return true
  if (!holdDays) return false
  return Date.parse(row.created_at) > now - holdDays * 86400000
}

// SECTION 4 ROUND 4 (bug): a refund before payout leaves an UNPAID original in one
// cycle and an UNPAID negative reversal in a later one (the reversal is dated when
// the refund landed). Every payable / per-cycle figure treated them independently, so
// the refunded sale's commission showed as "ready to pay" (and a cycle-scoped payout
// paid it) while the offsetting credit sat in the still-running cycle — leaving the
// platform out of pocket unless the partner earned again. A pair where BOTH rows are
// still unpaid nets to zero and is simply void: it is excluded from payable, held and
// per-cycle unpaid figures, and adminRecordPayout settles both rows together (under
// whichever payout touches either one) so they never linger. An original that was
// ALREADY paid keeps its reversal as a genuine credit — that one is not void.
function voidedPairIds(ledgerRows) {
  const rows = ledgerRows || []
  const unpaidOriginals = new Set(rows.filter(l => !l.payout_id && !l.reverses_ledger_id).map(l => l.id))
  const out = new Set()
  for (const l of rows) {
    if (!l.payout_id && l.reverses_ledger_id && unpaidOriginals.has(l.reverses_ledger_id)) {
      out.add(l.id)
      out.add(l.reverses_ledger_id)
    }
  }
  return out
}

// Optional minimum payout (env COMMISSION_MIN_PAYOUT_CENTS, default 0 = off).
// Payable commission below it is "carried forward" rather than shown as ready.
function payoutDetailsHoldHoursFor(env) {
  const raw = env?.PAYOUT_DETAILS_HOLD_HOURS
  if (raw === undefined || raw === null || String(raw).trim() === '') return 48
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 48
}

function minPayoutFor(env) {
  const n = parseInt(env?.COMMISSION_MIN_PAYOUT_CENTS, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}
function payoutReadiness(ledgerRows, holdDays, minPayout) {
  const payable = payableCents(ledgerRows, holdDays)
  const belowMinimum = minPayout > 0 && payable > 0 && payable < minPayout
  // `payable` goes negative when refund credits outweigh payable commission. That is
  // not "ready to pay" (and must never net against another partner's real payable in
  // the admin total) — it's reported separately as creditCents.
  return {
    readyToPayCents: belowMinimum ? 0 : Math.max(0, payable),
    creditCents: Math.max(0, -payable),
    carriedForwardCents: belowMinimum ? payable : 0, belowMinimum, minPayoutCents: minPayout
  }
}

// A refunded sale is two ledger rows (original + negative reversal). Net
// conversions = originals that have not been reversed.
function netConversionCount(ledgerRows) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  return rows.filter(l => !l.reverses_ledger_id && !reversed.has(l.id)).length
}

// Per-code performance: net conversions, net gross revenue and commission
// (reversal rows are negative, so plain sums already net out).
function buildCodeStats(ledgerRows, codes) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  const out = {}
  for (const code of codes || []) out[code.id] = { conversions: 0, grossCents: 0, commissionCents: 0 }
  for (const l of rows) {
    const b = out[l.referral_code_id]
    if (!b) continue
    b.grossCents += l.gross_amount_cents
    b.commissionCents += l.commission_amount_cents
    if (!l.reverses_ledger_id && !reversed.has(l.id)) b.conversions += 1
  }
  return out
}
function attachCodeStats(camelCodes, ledgerRows, rawCodes) {
  const stats = buildCodeStats(ledgerRows, rawCodes)
  return (camelCodes || []).map(rc => {
    const st = stats[rc.id] || { conversions: 0, grossCents: 0, commissionCents: 0 }
    return { ...rc, stats: { ...st, conversionRate: rc.clicks > 0 ? st.conversions / rc.clicks : null } }
  })
}
const sameInstant = (a, b) => (a == null && b == null) || (a != null && b != null && Date.parse(a) === Date.parse(b))
// Unpaid commission that is actually payable now: not in the running cycle
// and not held.
function payableCents(ledgerRows, holdDays) {
  const currentKey = cycleKey(new Date().toISOString())
  const voided = voidedPairIds(ledgerRows)
  return (ledgerRows || []).filter(l => !l.payout_id && !voided.has(l.id) && cycleKey(l.created_at) !== currentKey && !isHeldRow(l, holdDays))
    .reduce((sum, l) => sum + l.commission_amount_cents, 0)
}
function heldCentsOf(ledgerRows, holdDays) {
  const voided = voidedPairIds(ledgerRows)
  return (ledgerRows || []).filter(l => !voided.has(l.id) && isHeldRow(l, holdDays)).reduce((sum, l) => sum + l.commission_amount_cents, 0)
}

function buildCyclesSummary(ledgerRows, count, holdDays = 0) {
  const cycles = recentCycles(count)
  const rows = ledgerRows || []
  const voided = voidedPairIds(rows)
  const reversedIds = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  const currentKey = cycleKey(new Date().toISOString())
  const byKey = new Map(cycles.map(c => [c.key, {
    grossCents: 0, commissionCents: 0, unpaidCents: 0, paidCents: 0, heldCents: 0,
    ledgerCount: 0, payoutIds: new Set()
  }]))

  // Round 5: unpaid refund CREDITS (a reversal whose original was already paid) from CLOSED
  // cycles. A cycle-scoped payout settles all of them with it (adminRecordPayout), so each
  // cycle reports the part that lives OUTSIDE its own window — what the Pay button's default
  // amount must add to unpaidCents to match what the server will actually settle.
  let closedCreditCents = 0
  const creditByKey = new Map()
  for (const row of rows) {
    if (row.payout_id || !row.reverses_ledger_id || voided.has(row.id)) continue
    const k = cycleKey(row.created_at)
    if (k === currentKey) continue
    closedCreditCents += row.commission_amount_cents
    creditByKey.set(k, (creditByKey.get(k) || 0) + row.commission_amount_cents)
  }

  for (const row of rows) {
    const bucket = byKey.get(cycleKey(row.created_at))
    if (!bucket) continue  // older than the window being summarized
    bucket.grossCents      += row.gross_amount_cents
    bucket.commissionCents += row.commission_amount_cents
    // Only an ORIGINAL row that has not been reversed is a real conversion (a refund is a
    // SECOND, negative ledger row — see fulfillment.service.js's reverseCommission). Round 5:
    // a refunded original used to still count here, unlike the net totalConversions.
    if (!row.reverses_ledger_id && !reversedIds.has(row.id)) bucket.ledgerCount += 1
    if (row.payout_id) {
      bucket.paidCents += row.commission_amount_cents
      bucket.payoutIds.add(row.payout_id)
    } else if (!voided.has(row.id)) {
      bucket.unpaidCents += row.commission_amount_cents
      if (isHeldRow(row, holdDays)) bucket.heldCents += row.commission_amount_cents
    }
  }

  return cycles.map(c => {
    const b = byKey.get(c.key)
    return { ...c, grossCents: b.grossCents, commissionCents: b.commissionCents,
      unpaidCents: b.unpaidCents, paidCents: b.paidCents, heldCents: b.heldCents,
      outsideCreditCents: closedCreditCents - (c.key === currentKey ? 0 : (creditByKey.get(c.key) || 0)),
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
  email: z.string().trim().email(),
  // Round 4: a rate could only be set by a second PATCH after creation.
  commissionRate: z.number().min(0).max(1).optional()
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

// Shared by adminCreatePartner and application approval so both create a partner
// the same way. Returns { error: message } for a duplicate email, else { data }.
async function createPartnerRecord(ctx, supabase, { name, email, commissionRate, website, audience, termsAcceptedAt, termsVersion }, auditAction = 'partner.create', auditExtra = {}) {
  if (await emailUsedByAnotherPartner(supabase, email))
    return { error: 'A partner with that email address already exists.' }

  // Two independent bearer tokens: payout_details_token (WRITE — changes where money
  // goes; only ever mailed on its own) and dashboard_token (READ-ONLY — what the
  // conversion/reversal/code notification emails carry). See migration 0055.
  const token = cryptoLib.randomToken(32)

  const { data, error } = await supabase.from('partners').insert({
    name, email, payout_details_token: token, dashboard_token: cryptoLib.randomToken(32),
    ...(commissionRate != null ? { commission_rate: commissionRate } : {}),
    ...(website ? { website } : {}), ...(audience ? { audience } : {}),
    ...(termsAcceptedAt ? { terms_accepted_at: termsAcceptedAt, terms_version: termsVersion || null } : {})
  }).select('*').single()
  if (error) throw error

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${token}`
  // Best-effort — the partner record should exist even if the email send
  // fails (e.g. transient Resend error); admin can resend via adminResendPayoutLink.
  // SECTION 4 ROUND 5 (bug): the send's boolean result was discarded, so the admin UI
  // announced "payout-details link sent" even when the send was throttled or failed
  // and the partner never got a link. Report it, and hand back the link on failure so
  // the admin can pass it on by hand instead of hunting for the /links endpoint.
  const emailed = await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, email, name, payoutUrl)
    .then(ok => ok === true || ok === undefined)
    .catch(() => false)

  await logAdminAction(ctx, supabase, auditAction, 'partner', data.id, { commissionRate: data.commission_rate, emailed, ...auditExtra })
  return { data, emailed, ...(emailed ? {} : { payoutUrl }) }
}

async function adminCreatePartner(ctx) {
  const body = createPartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)
  const made = await createPartnerRecord(ctx, supabase, body)
  if (made.error) return ctx.json({ success: false, message: made.error }, 400)
  return ctx.json({ success: true, data: partnerRowToCamel(made.data), emailed: made.emailed, ...(made.payoutUrl ? { payoutUrl: made.payoutUrl } : {}) })
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
  // Case-insensitive, like the duplicate check above: "OLD@X.CO" is the same
  // mailbox as "old@x.co", so a casing-only edit must not kill the partner's
  // links, fire three emails and an owner alert, or log a false emailChanged.
  // (The new casing is still written.)
  const emailChanging = body.email !== undefined && !!before?.email && body.email.toLowerCase() !== before.email.toLowerCase()
  const rotatedToken  = emailChanging ? cryptoLib.randomToken(32) : null
  if (rotatedToken) { patch.payout_details_token = rotatedToken; patch.dashboard_token = cryptoLib.randomToken(32) }
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
  if (emailChanging) {
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
      emailChanging ||
      (body.status !== undefined && before?.status && before.status !== data.status)) {
    await logAdminAction(ctx, supabase, 'partner.update', 'partner', partnerId, {
      emailChanged: emailChanging,
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
  // SECTION 4 ROUND 4 (scale): this used to embed EVERY partner's full payout history,
  // code list and complete commission ledger into one query on every page load — cost
  // grew with total platform history. The list view only needs the UNPAID ledger rows
  // (pending / ready / held / current-cycle figures), so that is all it reads now, paged
  // so PostgREST's row cap can't silently truncate it. Payout history, codes and
  // per-code stats live behind adminGetPartner. (netConversions moved there too: it needs
  // paid rows, and no list column shows it.)
  const { data, error } = await supabase
    .from('partners')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error

  const ledgerByPartner = new Map()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error: lerr } = await supabase
      .from('commission_ledger')
      .select('id, partner_id, gross_amount_cents, commission_amount_cents, payout_id, reverses_ledger_id, created_at, payments(status)')
      .is('payout_id', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (lerr) throw lerr
    for (const r of rows || []) {
      if (!ledgerByPartner.has(r.partner_id)) ledgerByPartner.set(r.partner_id, [])
      ledgerByPartner.get(r.partner_id).push(r)
    }
    if (!rows || rows.length < PAGE) break
  }

  const holdDays = holdDaysFor(ctx.env)
  const partners = data.map(row => {
    const camel = partnerRowToCamel(row)
    const ledger = ledgerByPartner.get(row.id) || []
    const cycles = buildCyclesSummary(ledger, 2, holdDays)  // [current, previous]
    const currentCycle = cycles.find(cyc => cyc.isCurrent)

    camel.pendingCommissionCents  = pendingCents(ledger)
    // "Ready to pay" excludes the current, still-accruing cycle — that
    // matches the twice-a-month rhythm: a cycle isn't payable until it's
    // over. Anything unpaid from BEFORE the current cycle (including any
    // older, un-summarized cycles beyond this 2-cycle window) is ready now.
    camel.currentCycleAccruedCents = currentCycle ? currentCycle.unpaidCents : 0
    Object.assign(camel, payoutReadiness(ledger, holdDays, minPayoutFor(ctx.env)))
    camel.heldCents                = heldCentsOf(ledger, holdDays)
    camel.currentCycleLabel        = currentCycle ? currentCycle.label : null
    // Currency for the commission-derived figures above. (commission_ledger DOES
    // carry a per-row currency — adminGetPartner selects it — but the list select
    // deliberately skips it, and there is one currency for the whole platform, so
    // the list view labels every figure with env.PAYSTACK_CURRENCY.)
    camel.currency                 = ctx.env.PAYSTACK_CURRENCY || c.CURRENCY
    return camel
  })
  // Round 6: the payout-details hold the server enforces, so the "Record payout run" screen flags the same partners.
  return ctx.json({ success: true, payoutDetailsHoldHours: payoutDetailsHoldHoursFor(ctx.env), data: partners })
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
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, internal_note, settled_commission_cents, period_start, period_end, paid_at, created_at, payout_details_snapshot, voided_at, void_reason),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, currency, payout_id, reverses_ledger_id, reversal_reason, usage_counted, created_at, payments(status, paystack_ref))
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
  Object.assign(camel, payoutReadiness(ledger, holdDays, minPayoutFor(ctx.env)))
  camel.heldCents = heldCentsOf(ledger, holdDays)
  camel.holdDays = holdDays
  camel.netConversions = netConversionCount(ledger)
  // Code text per ledger row (for the Conversions tab) + per-code performance.
  const codeTextById = new Map((row.referral_codes || []).map(cd => [cd.id, cd.code]))
  camel.commissionLedger = camel.commissionLedger.map(l => ({ ...l, code: codeTextById.get(l.referralCodeId) || null }))
  camel.referralCodes = attachCodeStats(camel.referralCodes, ledger, row.referral_codes)
  // AUDIT FIX (Section 3/4 pass, bug): see the matching fix in
  // adminListPartners above — same currency-drift gap, same fix.
  camel.currency = ctx.env.PAYSTACK_CURRENCY || c.CURRENCY
  // Round 6: surfaced for the admin screen — the hold window the server enforces on payouts after a payout-details
  // change, and whether unpaid commission spans more than one currency (a payout can only settle one).
  camel.payoutDetailsHoldHours = payoutDetailsHoldHoursFor(ctx.env)
  camel.unpaidCurrencies = [...new Set(ledger.filter(l => !l.payout_id).map(l => String(l.currency || camel.currency).toUpperCase()))]
  camel.mixedCurrency = camel.unpaidCurrencies.length > 1

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
  // Round 5: the response carries a bearer link, so it leaves the same trace
  // adminGetPartnerLinks does.
  await logAdminAction(ctx, supabase, 'partner.payout_link_resent', 'partner', partnerId, { emailed: sent })
  // Round 6: the write-token URL is only handed back when the email did NOT go (so the admin can pass it on by
  // hand) — it used to be returned, and copied to the admin's clipboard, on every successful resend too. And a
  // false from the sender includes the per-partner cap of 4 emails an hour, which "send failed" didn't say.
  return ctx.json({ success: sent,
    message: sent ? 'Link re-sent.' : 'Email not sent — it failed or hit this partner\'s 4-per-hour limit. Check logs, or copy the link instead.',
    ...(sent ? {} : { payoutUrl }) })
}

// ── Admin: ROTATE a partner's payout-details link ───────────────────────────
// Issues a brand-new token and overwrites the old one, so the previous link
// stops working the instant this runs. There was previously no way to
// invalidate a payout link short of a direct DB edit — this link is the
// only thing standing between an email compromise and someone redirecting
// a real future payout, and it never expired or rotated on its own.

// Round 5: `scope` — 'payout' (default, the old behaviour), 'dashboard' or 'both'. The
// read-only dashboard link is the one every conversion email carries, so it is the one most
// likely to be forwarded or leaked, and it previously could never be rotated at all.
const regenerateLinkSchema = z.object({ scope: z.enum(['payout', 'dashboard', 'both']).optional() })

async function adminRegeneratePayoutLink(ctx) {
  const partnerId = ctx.req.param('id')
  // The body is optional (the pre-round-5 caller sent none) — absent or unparsable means 'payout'.
  let raw = {}
  try { raw = await ctx.req.json() } catch (_) { raw = {} }
  const { scope = 'payout' } = regenerateLinkSchema.parse(raw || {})
  const supabase = getSupabase(ctx.env)
  const rotatePayout = scope === 'payout' || scope === 'both'
  const rotateDash   = scope === 'dashboard' || scope === 'both'
  const newPayoutToken = rotatePayout ? cryptoLib.randomToken(32) : null
  const newDashToken   = rotateDash ? cryptoLib.randomToken(32) : null

  const { data: partner, error } = await supabase
    .from('partners')
    .update({ ...(rotatePayout ? { payout_details_token: newPayoutToken } : {}), ...(rotateDash ? { dashboard_token: newDashToken } : {}) })
    .eq('id', partnerId)
    .select('name, email')
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutUrl    = rotatePayout ? `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${newPayoutToken}` : null
  const dashboardUrl = rotateDash ? `${ctx.env.FRONTEND_URL}/partner/dashboard?token=${newDashToken}` : null
  const results = await Promise.all([
    rotatePayout ? emailService.sendPartnerLinkRegenerated(ctx.env, supabase, partner.email, partner.name, payoutUrl).catch(() => false) : true,
    rotateDash ? emailService.sendPartnerDashboardLinkRegenerated(ctx.env, supabase, partner.email, partner.name, dashboardUrl).catch(() => false) : true
  ])
  const emailed = results.every(Boolean)

  // FEATURE GAP CLOSED (Section 12 audit): rotating a bearer link leaves a durable trace of
  // which admin did it and when.
  await logAdminAction(ctx, supabase, 'partner.payout_link_regenerated', 'partner', partnerId, { emailed, scope })

  // Admin-facing fallback: echo the freshly minted link(s) so a failed email is not a dead end.
  return ctx.json({ success: true, emailed, scope,
    message: emailed ? 'Link reset — new link emailed.' : 'Link reset, but the notification email failed to send.',
    ...(payoutUrl ? { payoutUrl } : {}), ...(dashboardUrl ? { dashboardUrl } : {}) })
}

// ── Admin: create a referral code for a partner ─────────────────────────────
// Emails the partner their code + dashboard link immediately — this is the
// moment their dashboard actually becomes useful, so it's the natural point
// to send them there rather than at partner-creation time.

// Round 4 (feature gap): there was no way for an admin to get a partner's DASHBOARD
// link at all (only the payout link could be re-sent), so "can you check what my
// dashboard shows" meant guessing. Returns both links; admin-only and audit-logged
// because they are bearer credentials.
async function adminGetPartnerLinks(ctx) {
  const partnerId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners').select('dashboard_token, payout_details_token').eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  ctx.header('Cache-Control', 'no-store')
  await logAdminAction(ctx, supabase, 'partner.links_viewed', 'partner', partnerId, {})
  return ctx.json({ success: true, data: {
    dashboardUrl: `${ctx.env.FRONTEND_URL}/partner/dashboard?token=${partner.dashboard_token}`,
    payoutUrl:    `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${partner.payout_details_token}`
  } })
}

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
    .from('partners').select('name, email, dashboard_token, status').eq('id', partnerId).maybeSingle()
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

  // A PAUSED partner's codes don't apply discounts or earn commission (see
  // isCodeUsable), so telling them "your code is ready" would be wrong — the
  // code is created and waits for reactivation; the admin is told as much.
  const partnerPaused = partner.status !== 'ACTIVE'
  if (!partnerPaused) {
    const dashboardUrl = `${ctx.env.FRONTEND_URL}/partner/dashboard?token=${partner.dashboard_token}`
    await emailService.sendReferralCodeCreated(ctx.env, supabase, partner.email, partner.name, codeRow.code, dashboardUrl)
      .catch(() => {})
  }

  await logAdminAction(ctx, supabase, 'partner.referral_code_created', 'referral_code', codeRow.id, {
    partnerId, code: codeRow.code, tierPrices: codeRow.tier_prices, usageLimit: codeRow.usage_limit, expiresAt: codeRow.expires_at
  })

  return ctx.json({ success: true, data: referralCodeRowToCamel(codeRow), notified: !partnerPaused, partnerPaused })
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
  currency:     z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code.').transform(v => v.toUpperCase()).optional(),
  payoutMethod: z.enum(['BANK', 'MOBILE_MONEY']).optional(),
  // Shown to the partner on their dashboard. Anything internal belongs in internalNote.
  note:         z.string().trim().max(500).optional(),
  internalNote: z.string().trim().max(500).optional(),
  // Required (with a note) when amountCents differs from the commission the
  // payout settles — see the check in adminRecordPayout.
  acknowledgeDifference: z.boolean().optional(),
  // Round 6: the admin states they confirmed a recent payout-details change with the partner directly
  // (required inside the PAYOUT_DETAILS_HOLD_HOURS window — see recordPayoutCore).
  confirmedWithPartner: z.boolean().optional(),
  // The payout_details_submitted_at the admin was LOOKING AT when they sent the
  // money. If the partner (or anyone holding their link) changed the details
  // since, the payout is refused so money isn't recorded against an account the
  // admin never saw. Optional so scripts keep working; the admin UI always sends it.
  // SECTION 4 ROUND 5 (bug): the admin screen echoes this back exactly as PostgREST
  // returned it — `2026-09-01T10:00:00.123456+00:00`, an OFFSET timestamp — and zod's
  // datetime() rejects offsets unless told otherwise, so EVERY payout for a partner who had
  // submitted details failed with "Validation failed". sameInstant() compares instants, so
  // any valid offset form is fine.
  expectedDetailsSubmittedAt: z.string().datetime({ offset: true }).nullable().optional(),
  periodStart:  z.string().datetime().optional(),
  periodEnd:    z.string().datetime().optional()
}).refine(b => Boolean(b.periodStart) === Boolean(b.periodEnd),
  'periodStart and periodEnd must be provided together.')

async function adminRecordPayout(ctx) {
  const partnerId = ctx.req.param('id')
  const body = recordPayoutSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)
  return recordPayoutCore(ctx, supabase, partnerId, body, (json, status) => (status ? ctx.json(json, status) : ctx.json(json)))
}

// Section 4 round 6: the whole payout-recording flow, parameterised on how it answers so the
// single-partner endpoint and the batch endpoint run exactly the same checks. `reply(json, status)`
// is ctx.json for the former and a collector for the latter. opts.scope === 'ready' settles only what
// is payable NOW (closed cycles, past the hold, plus refund credits) — the figure the admin list shows
// as "Ready to pay" — instead of the partner's entire balance.
async function recordPayoutCore(ctx, supabase, partnerId, body, reply, opts = {}) {

  const { data: partner, error: pErr } = await supabase
    .from('partners').select('*').eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return reply({ success: false, message: 'Partner not found.' }, 404)

  // SECTION 4 ROUND 5 (bug): `body.payoutMethod || partner.payout_method` let an API caller
  // record a payout "by BANK" for a partner with no details at all (the guard below was
  // satisfied by the override), or stamp BANK on a snapshot of mobile-money details. The
  // method is whatever the partner's stored details say; an override may only confirm it.
  const payoutMethod = partner.payout_method
  if (!payoutMethod)
    return reply({ success: false,
      message: 'This partner has not submitted payout details yet — nothing to pay to.' }, 400)
  if (body.payoutMethod && body.payoutMethod !== payoutMethod)
    return reply({ success: false,
      message: `This partner's payout details are for ${payoutMethod === 'BANK' ? 'a bank transfer' : 'mobile money'}, not ${body.payoutMethod === 'BANK' ? 'a bank transfer' : 'mobile money'}.` }, 400)

  if (body.expectedDetailsSubmittedAt !== undefined &&
      !sameInstant(body.expectedDetailsSubmittedAt, partner.payout_details_submitted_at))
    return reply({ success: false, code: 'PAYOUT_DETAILS_CHANGED',
      message: "This partner's payout details changed since you opened this screen. Reload, check where the money should go, and re-confirm before recording." }, 409)

  // Round 6 (feature gap): a payout-details change is the one thing a leaked link can do that moves money,
  // and the 7-day banner in the admin screen was advice only. Within PAYOUT_DETAILS_HOLD_HOURS (default 48,
  // 0 = off) of the last change the server refuses to record a payout unless the admin states they confirmed
  // the change with the partner directly.
  const holdHours = payoutDetailsHoldHoursFor(ctx.env)
  if (holdHours > 0 && partner.payout_details_submitted_at && !body.confirmedWithPartner) {
    const changedMs = Date.parse(partner.payout_details_submitted_at)
    if (Number.isFinite(changedMs) && Date.now() - changedMs < holdHours * 3600000)
      return reply({ success: false, code: 'PAYOUT_DETAILS_RECENT',
        message: `This partner's payout details were changed in the last ${holdHours} hours. Confirm with them directly that the change was theirs, then record the payout with the confirmation ticked.` }, 409)
  }

  let ledgerQuery = supabase.from('commission_ledger').select('id, commission_amount_cents, reverses_ledger_id, currency, payments(status)')
    .eq('partner_id', partnerId).is('payout_id', null)
  if (body.periodStart) ledgerQuery = ledgerQuery.gte('created_at', body.periodStart).lte('created_at', body.periodEnd)
  else if (opts.scope === 'ready') ledgerQuery = ledgerQuery.lt('created_at', recentCycles(1)[0].start)
  // Refund-window hold (COMMISSION_HOLD_DAYS): young commission rows stay
  // unpaid; reversal rows always settle.
  const holdDays = holdDaysFor(ctx.env)
  if (holdDays) {
    const cutoff = new Date(Date.now() - holdDays * 86400000).toISOString()
    ledgerQuery = ledgerQuery.or(`reverses_ledger_id.not.is.null,created_at.lte.${cutoff}`)
  }
  // Paged: PostgREST silently truncates one response at its max-rows cap (1000 by default),
  // and this query had no order, so a big ad hoc backlog was settled — and priced — from an
  // arbitrary 1000 rows. A stable order makes the pages consistent.
  const ledgerRaw = []
  for (let from = 0; ; from += 1000) {
    const { data: page, error: pageErr } = await ledgerQuery.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999)
    if (pageErr) throw pageErr
    ledgerRaw.push(...(page || []))
    if (!page || page.length < 1000) break
  }
  // Commission on a payment with an OPEN dispute is not payable (a lost dispute
  // reverses it); reversal rows always settle.
  let unpaidLedger = (ledgerRaw || []).filter(l => l.reverses_ledger_id || l.payments?.status !== 'DISPUTED')

  // SECTION 4 ROUND 5 (bug): a refund credit lives in the cycle the refund LANDED in, so a
  // cycle-scoped payout never saw one dated in another cycle. "Ready to pay" and the payout-run
  // CSV net credits across cycles, the Pay button did not — so the admin either overpaid (and
  // the credit then netted a SECOND time against the next payout) or the credit sat stranded
  // forever. A cycle payout now settles every unpaid credit from a CLOSED cycle with it, which
  // is exactly the set payableCents() already nets. (The running cycle is excluded there too,
  // so the two figures agree.) A reversal whose original is still unpaid is a void pair and is
  // settled together with that original by the pair logic below.
  if (body.periodStart) {
    const runningStart = recentCycles(1)[0].start
    const { data: credits, error: creditErr } = await supabase.from('commission_ledger')
      .select('id, commission_amount_cents, reverses_ledger_id, currency, payments(status)')
      .eq('partner_id', partnerId).is('payout_id', null).not('reverses_ledger_id', 'is', null).lt('created_at', runningStart)
    if (creditErr) throw creditErr
    const haveIds = new Set(unpaidLedger.map(l => l.id))
    for (const row of credits || []) if (row.reverses_ledger_id && !haveIds.has(row.id)) unpaidLedger.push(row)
  }

  // SECTION 4 ROUND 4 (bug): settle refund PAIRS together. A refunded-before-payout sale
  // is an unpaid original plus an unpaid negative reversal, usually in DIFFERENT cycles.
  // Scoping by period (or the hold filter, which keeps a young original out while its
  // reversal is always in) split them: the original was paid and only a credit remained.
  // Pull in the unpaid counterpart of every row selected, so the pair nets to zero and
  // both rows are claimed by this payout. A counterpart that is already PAID is never
  // pulled in — its reversal then stays a genuine credit, as before.
  {
    const have = new Set(unpaidLedger.map(l => l.id))
    const originalIds = unpaidLedger.filter(l => !l.reverses_ledger_id).map(l => l.id)
    const missingOriginalIds = [...new Set(unpaidLedger.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))].filter(id => !have.has(id))
    const extra = []
    if (originalIds.length) {
      const { data: revs, error: rErr } = await supabase.from('commission_ledger')
        .select('id, commission_amount_cents, reverses_ledger_id, currency, payments(status)')
        .eq('partner_id', partnerId).is('payout_id', null).in('reverses_ledger_id', originalIds)
      if (rErr) throw rErr
      // Re-verified here rather than trusting the query alone: only a row that really is the
      // reversal of a selected original may ride along (never an unrelated/DISPUTED row).
      const wanted = new Set(originalIds)
      extra.push(...(revs || []).filter(r => r.reverses_ledger_id && wanted.has(r.reverses_ledger_id)))
    }
    if (missingOriginalIds.length) {
      const { data: origs, error: oErr } = await supabase.from('commission_ledger')
        .select('id, commission_amount_cents, reverses_ledger_id, currency, payments(status)')
        .eq('partner_id', partnerId).is('payout_id', null).in('id', missingOriginalIds)
      if (oErr) throw oErr
      const wanted = new Set(missingOriginalIds)
      extra.push(...(origs || []).filter(r => !r.reverses_ledger_id && wanted.has(r.id)))
    }
    for (const row of extra) if (!have.has(row.id)) { have.add(row.id); unpaidLedger.push(row) }
  }

  // Round 6 (bug): `currency` was any 3 characters ('usd' stored as-is) and was never compared with the
  // ledger rows being settled, so a payout could silently total commission earned in one currency and label
  // it another (the ledger has carried its own currency since 0051). Normalised, and refused on a mismatch.
  const envCurrency = String(ctx.env.PAYSTACK_CURRENCY || c.CURRENCY).toUpperCase()
  const currency = body.currency || envCurrency
  const ledgerCurrencies = new Set(unpaidLedger.map(l => String(l.currency || envCurrency).toUpperCase()))
  if ([...ledgerCurrencies].some(cur => cur !== currency))
    return reply({ success: false, code: 'CURRENCY_MISMATCH',
      message: `The commission this payout settles is in ${[...ledgerCurrencies].join('/')}, not ${currency}. Record it in that currency (one payout per currency).` }, 400)

  // "Auto" = the payout is for exactly what the ledger says is owed. The admin UI always
  // sends amountCents (it is the amount actually transferred, and sending it is what makes
  // a stale screen trip AMOUNT_DIFFERS), so an amount that merely EQUALS the owed figure
  // must get the same race recovery and minimum-payout rules as an omitted one — before
  // this, both were unreachable from the UI.
  const autoAmountOf = owed => body.amountCents == null || body.amountCents === owed


  const owedCents   = unpaidLedger.reduce((sum, l) => sum + l.commission_amount_cents, 0)
  const autoAmount  = autoAmountOf(owedCents)
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
    return reply({ success: false, message: owedCents < 0
      ? `Net owed is negative (${owedCents} cents) because of refund/chargeback reversals — nothing to pay. It will net against this partner's future commission.`
      : 'Nothing owed for this scope.' }, 400)
  const amountCents = body.amountCents ?? owedCents

  // Optional minimum payout: a CYCLE-scoped payout below it is refused (the
  // commission carries forward). Ad hoc payouts are the deliberate override.
  const minPayout = minPayoutFor(ctx.env)
  if ((body.periodStart || opts.scope === 'ready') && minPayout > 0 && owedCents > 0 && owedCents < minPayout && autoAmount)
    return reply({ success: false, code: 'BELOW_MINIMUM',
      message: `This cycle's commission (${owedCents} cents) is below the minimum payout (${minPayout} cents), so it carries forward. Use an ad hoc payout to override.` }, 400)

  // Paying a different amount than the commission being settled used to be
  // silent: every in-scope ledger row is marked paid regardless, so an
  // underpayment vanished from the books and an overpayment left no trace.
  // Now the admin must acknowledge it and say why (the note is kept).
  if (amountCents !== owedCents && !(body.acknowledgeDifference && (body.note || body.internalNote))) {
    return reply({ success: false, code: 'AMOUNT_DIFFERS',
      message: `Amount (${amountCents}) differs from the commission this payout settles (${owedCents}). ` +
        `Confirm the difference and add a note (internal note is fine) explaining it.` }, 400)
  }

  const { data: payout, error } = await supabase.from('payouts').insert({
    partner_id:              partnerId,
    amount_cents:            amountCents,
    currency,
    payout_method:           payoutMethod,
    payout_details_snapshot: partner.payout_details || {},
    settled_commission_cents: owedCents,
    note:                    body.note || null,
    internal_note:           body.internalNote || null,
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
      // Auto-computed amount and this call won NOTHING (a concurrent payout took
      // every row): this payout is a phantom — keep no row, send no "payout on its
      // way" email, tell the admin plainly.
      if (autoAmount && (claimed || []).length === 0) {
        const { error: delErr } = await supabase.from('payouts').delete().eq('id', payout.id)
        if (delErr) console.error('adminRecordPayout phantom payout cleanup:', delErr.message)
        try {
          await emailService.sendOwnerAlert(ctx.env,
            'Payout recording lost a race — duplicate payout discarded',
            `partner: ${partner.name} <${partner.email}>\npayout id: ${payout.id}${delErr ? ' (cleanup FAILED — delete this row by hand)' : ' (row removed)'}\n\n` +
            `Two payout recordings overlapped for this partner and the other one settled every commission. ` +
            `Check the payout history before sending any more money.`, { dedupeKey: partnerId })
        } catch (_) {}
        return reply({ success: false, code: 'PAYOUT_RACED',
          message: 'Another payout was recorded for this partner at the same moment and already settled everything. Nothing was recorded here — check the payout history before sending any more money.' }, 409)
      }
      // One update carries both the true settled figure and (when the amount
      // was auto-computed) the corrected amount.
      const settledPatch = { settled_commission_cents: actuallySettledCents }
      if (body.amountCents == null) {
        // Only when the amount was truly omitted: a typed amount is what the admin actually
        // transferred, so it is never rewritten (the owner alert below flags the mismatch).
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

  return reply({ success: true, data: payoutRowToCamel(payoutRow), emailed, racedWithConcurrentPayout, ledgerSettlementFailed })
}

// ── Round 6 (feature gap): record a whole payout run at once ─────────────────
// "Export payout run" produced a CSV, but every payout then had to be recorded one partner at a time.
// Each item goes through recordPayoutCore — the same checks as the single endpoint — scoped to what is
// payable NOW ('ready'), so the amount on the admin's screen is exactly what gets settled. A stale amount,
// changed payout details, a recent-change hold or a currency mismatch fails THAT item only; the rest go
// through. Sequential on purpose (a payout is ~10 queries; parallel runs would trip the Worker's limits).
const BATCH_PAYOUT_MAX = 25
const batchPayoutSchema = z.object({
  items: z.array(z.object({
    partnerId:    z.string().regex(UUID_RE, 'Invalid partner id.'),
    amountCents:  z.number().int().positive(),
    expectedDetailsSubmittedAt: z.string().datetime({ offset: true }).nullable(),
    confirmedWithPartner: z.boolean().optional(),
    note:         z.string().trim().max(500).optional(),
    internalNote: z.string().trim().max(500).optional()
  })).min(1).max(BATCH_PAYOUT_MAX)
})

async function adminRecordPayoutBatch(ctx) {
  const body = batchPayoutSchema.parse(await ctx.req.json())
  const ids = body.items.map(i => i.partnerId)
  if (new Set(ids).size !== ids.length)
    return ctx.json({ success: false, message: 'Each partner may appear only once in a run.' }, 400)
  const supabase = getSupabase(ctx.env)
  const results = []
  for (const item of body.items) {
    try {
      const out = await recordPayoutCore(ctx, supabase, item.partnerId, {
        amountCents: item.amountCents,
        expectedDetailsSubmittedAt: item.expectedDetailsSubmittedAt,
        confirmedWithPartner: item.confirmedWithPartner,
        note: item.note, internalNote: item.internalNote
      }, (json, status) => ({ status: status || 200, json }), { scope: 'ready' })
      results.push({
        partnerId: item.partnerId, ok: out.status < 400 && out.json.success === true, status: out.status,
        ...(out.json.code ? { code: out.json.code } : {}),
        message: out.json.message || null,
        ...(out.json.data ? { payout: out.json.data } : {}),
        ...(out.json.emailed !== undefined ? { emailed: out.json.emailed } : {}),
        ...(out.json.ledgerSettlementFailed ? { ledgerSettlementFailed: true } : {})
      })
    } catch (err) {
      console.error('adminRecordPayoutBatch item failed:', err.message)
      results.push({ partnerId: item.partnerId, ok: false, status: 500, message: 'Unexpected error — check the payout history before retrying.' })
    }
  }
  const recorded = results.filter(r => r.ok).length
  await logAdminAction(ctx, supabase, 'partner.payout_batch', 'payout_batch', null, {
    requested: results.length, recorded, failed: results.length - recorded
  })
  return ctx.json({ success: true, data: { results, recorded, failed: results.length - recorded } })
}

// ── Public (token-gated): partner views their own current payout details ───

// Bearer-token responses must never be cached or indexed anywhere on the path.
function noStore(ctx) {
  ctx.header('Cache-Control', 'no-store')
  ctx.header('X-Robots-Tag', 'noindex, nofollow')
}

// SECTION 4 ROUND 5 (hardening): both partner bearer tokens used to travel ONLY in the
// query string (`?token=`), so they were written into every request log (Workers
// observability samples 100% of requests) — and the payout token can redirect real money.
// The SPA now sends the token in the X-Partner-Token header; `?token=` is still accepted
// so links already sitting in inboxes and older cached bundles keep working. Whatever the
// source, a token is a bounded string (it goes into an equality filter).
function partnerTokenOf(ctx) {
  const fromHeader = ctx.req.header?.('x-partner-token')
  const raw = (typeof fromHeader === 'string' && fromHeader.trim()) || ctx.req.query('token') || ''
  const token = String(raw).trim()
  return token.length > 0 && token.length <= 200 ? token : ''
}

// Resolves a partner from either bearer token (dashboard = read-only, payout = write).
// Two sequential exact-match lookups — never a user-supplied string inside an or() filter.
async function findPartnerByAnyToken(supabase, token, columns) {
  for (const [column, which] of [['dashboard_token', 'dashboard'], ['payout_details_token', 'payout']]) {
    const { data, error } = await supabase.from('partners').select(columns).eq(column, token).maybeSingle()
    if (error) throw error
    if (data) return { partner: data, scope: which }
  }
  return { partner: null, scope: null }
}

async function getPartnerByToken(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners')
    .select('name, payout_method, payout_details, payout_details_submitted_at, dashboard_token')
    .eq('payout_details_token', token)
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  // The payout page links on to the dashboard using the READ-ONLY token, so the
  // write-capable token never rides in a dashboard URL.
  return ctx.json({ success: true, data: { ...partnerRowToCamel(partner), dashboardToken: partner.dashboard_token } })
}

// ── Public (token-gated): partner submits/updates their payout details ─────

// Round 4: both were bare "non-empty string" fields, so a typo'd account number or a
// phone number with letters was accepted and real money later went to the wrong place.
// Formats stay deliberately permissive (spaces/dashes allowed, IBANs and every national
// scheme fit) — this catches typos and junk, not every invalid account.
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{3,33}$/
const PHONE_RE          = /^\+?\(?[0-9][0-9 ()\-]{6,19}$/
const bankDetailsSchema = z.object({
  payoutMethod:  z.literal('BANK'),
  bankName:      z.string().trim().min(1).max(200),
  accountName:   z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().regex(ACCOUNT_NUMBER_RE, 'Enter a valid account number (4–34 letters, digits, spaces or dashes).')
})
const mobileMoneyDetailsSchema = z.object({
  payoutMethod: z.literal('MOBILE_MONEY'),
  provider:     z.string().trim().min(1).max(100),
  accountName:  z.string().trim().min(1).max(200),
  phoneNumber:  z.string().trim().regex(PHONE_RE, 'Enter a valid phone number, e.g. +254 712 345 678.')
})
const payoutDetailsSchema = z.discriminatedUnion('payoutMethod', [
  bankDetailsSchema, mobileMoneyDetailsSchema
])

// "BANK ...4821" / "MOBILE_MONEY ...5678" / "none" — enough to compare with the partner, never the full number.
function describePayoutTarget(method, details) {
  if (!method) return 'none'
  const raw = String(details?.accountNumber || details?.phoneNumber || '').replace(/\s+/g, '')
  return `${method} ${raw ? `...${raw.slice(-4)}` : '(no number)'}`
}

async function submitPayoutDetails(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const body = payoutDetailsSchema.parse(await ctx.req.json())
  const { payoutMethod, ...details } = body
  const supabase = getSupabase(ctx.env)

  // Round 6: read what is being replaced so the owner alert can say WHAT changed (method + last 4 of the
  // account / phone, old -> new) — "details changed" alone gave nothing to check against the partner.
  const { data: previous, error: prevErr } = await supabase.from('partners')
    .select('payout_method, payout_details').eq('payout_details_token', token).maybeSingle()
  if (prevErr) throw prevErr
  if (!previous) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  const changedAt = new Date().toISOString()
  const { data, error } = await supabase.from('partners')
    .update({
      payout_method:                payoutMethod,
      payout_details:                details,
      payout_details_submitted_at:  changedAt,
      updated_at:                    changedAt
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
      `partner: ${data.name} <${data.email}>\nbefore: ${describePayoutTarget(previous.payout_method, previous.payout_details)}\n` +
      `after:  ${describePayoutTarget(payoutMethod, details)}\ntime: ${changedAt}\n\n` +
      `If this wasn't expected, verify with the partner directly before their next payout. ` +
      `Payouts are blocked for ${payoutDetailsHoldHoursFor(ctx.env)} hours after a change unless an admin confirms it with the partner.`,
      // Round 6 (bug): keyed on the token alone, a SECOND change within the 10-minute alert dedupe window —
      // exactly what a hijacker re-pointing the account after the real partner edited it would produce —
      // sent no email at all. Every distinct change now alerts (the 5-per-15-minute write limit bounds volume).
      { dedupeKey: `${token}|${changedAt}` }
    ).catch(() => {})
  ])

  return ctx.json({ success: true, message: 'Payout details saved.' })
}

// ── Public (token-gated): partner's own stats dashboard ─────────────────────
// Same token as the payout-details form — one link, two pages. Read-only:
// a partner can see their codes/earnings but never edit pricing or rates.

// The partner-facing shape of one ledger row (no internal ids beyond the row's own, no payment refs).
function conversionRowOf(row, codeTextById) {
  return {
    id:                    row.id,
    code:                  codeTextById.get(row.referral_code_id) || null,
    grossAmountCents:      row.gross_amount_cents,
    commissionRate:        row.commission_rate == null ? null : Number(row.commission_rate),
    commissionAmountCents: row.commission_amount_cents,
    paid:                  !!row.payout_id,
    isReversal:            !!row.reverses_ledger_id,
    reversalReason:        row.reversal_reason ?? null,
    createdAt:             row.created_at
  }
}

async function getPartnerDashboard(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  // The dashboard opens with EITHER token: dashboard_token (read-only, what emails
  // carry now) or the legacy/payout token (links already sitting in old inboxes).
  // Two sequential exact-match lookups — never a user-supplied string inside an or()
  // filter. `scope` tells the page whether the holder may edit payout details directly.
  let partner = null, error = null, scope = 'dashboard'
  for (const [column, which] of [['dashboard_token', 'dashboard'], ['payout_details_token', 'payout']]) {
    const res = await supabase
    .from('partners')
    .select(`
      name, commission_rate, status, payout_method, notify_conversions,
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      commission_ledger(id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, reverses_ledger_id, reversal_reason, created_at, payments(status)),
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, settled_commission_cents, period_start, period_end, paid_at, created_at, voided_at)
    `)
    .eq(column, token)
    // AUDIT FIX (feature gap): these three sub-selects came back in whatever
    // order Postgres felt like — adminGetPartner already orders the same
    // three relations for exactly this reason (a partner-facing "recent
    // activity" list is meaningless out of order). Matching that here too.
    .order('paid_at',    { foreignTable: 'payouts',           ascending: false })
    .order('created_at', { foreignTable: 'referral_codes',    ascending: false })
    .order('created_at', { foreignTable: 'commission_ledger', ascending: false })
    .maybeSingle()
    if (res.error) { error = res.error; break }
    if (res.data) { partner = res.data; scope = which; break }
  }
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
  const readiness = payoutReadiness(ledger, holdDays, minPayoutFor(ctx.env))
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
  const conversions = ledger.slice(0, CONVERSIONS_LIST_LIMIT).map(row => conversionRowOf(row, codeTextById))

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
    // Per-code conversions + conversion rate (clicks -> sales), net of refunds.
    // partnerId is an internal id with no partner-facing purpose — dropped here (round 5).
    referralCodes:  attachCodeStats(codes.map(referralCodeRowToCamel), ledger, codes).map(({ partnerId, ...rc }) => ({
      ...rc, stats: { conversions: rc.stats.conversions, conversionRate: rc.stats.conversionRate }
    })),
    notifyConversions: partner.notify_conversions !== false,
    // So the dashboard can prompt for payout details while money is owed.
    hasPayoutDetails: !!partner.payout_method,
    heldCents:        heldCentsOf(ledger, holdDays),
    minPayoutCents:      readiness.minPayoutCents,
    belowMinimum:        readiness.belowMinimum,
    carriedForwardCents: readiness.carriedForwardCents,
    // Round 6: the figures the admin side has always had — what the next payout run will actually pay, and any
    // refund credit that will net against it. Previously the partner had to add up the cycle rows themselves.
    readyToPayCents:     readiness.readyToPayCents,
    creditCents:         readiness.creditCents,
    conversions,
    // So the frontend can say "showing the most recent 50 of 214" instead of
    // silently looking complete when it isn't.
    conversionsTotal: ledger.length,
    // Round 4 (bug): payouts.note was shown to partners, but the admin form told admins
    // to use it to explain an under/over-payment — internal wording on a partner-facing
    // page. Notes are now an explicit partner-visible field; internal_note is never
    // selected here; and a legacy note on a payout whose amount differs from what it
    // settled (the only case that used to force an explanation) is withheld. Mapped
    // field-by-field so settledCommissionCents / partnerId never reach the partner.
    // A voided payout (recorded in error, migration 0058) never happened as far as the
    // partner is concerned — its ledger rows were released back to unpaid.
    payouts:        (partner.payouts || []).filter(po => !po.voided_at).map(po => ({
      id: po.id, amountCents: po.amount_cents, currency: po.currency, payoutMethod: po.payout_method,
      status: po.status, periodStart: po.period_start, periodEnd: po.period_end,
      paidAt: po.paid_at, createdAt: po.created_at,
      note: po.settled_commission_cents != null && po.settled_commission_cents !== po.amount_cents ? null : (po.note ?? null)
    })),
    // 'payout' => this link may edit payout details directly; 'dashboard' => read-only,
    // the page offers "email me a payout-details link" instead (requestPayoutLink below).
    scope,
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
      // Net of refunds: a sale that was later refunded is no longer a conversion.
      totalConversions: netConversionCount(ledger),
      pendingCents:     pendingCents(ledger),
      paidCents:        ledger.filter(l => l.payout_id).reduce((sum, l) => sum + l.commission_amount_cents, 0)
    }
  } })
}

// ── Public: click tracking ──────────────────────────────────────────────────
// Fired by the frontend (useReferralCapture) whenever a ?ref=CODE link is
// visited. Best-effort, high-volume, no sensitive data — an unknown or
// malformed code is a silent no-op, never an error the frontend has to handle.

// Link-preview fetchers, crawlers and scripted clients follow ?ref= links but are
// not people; counting them inflates clicks and wrecks the conversion rate.
// ── Public (token-gated): "email me my payout-details link" ────────────────
// The dashboard link is read-only and is mailed on every conversion; changing where
// money goes needs the separate payout token, and the only way a dashboard-link holder
// gets it is to have it emailed to the address on file — so a forwarded or leaked
// notification email can read earnings but cannot redirect a payout. Always answers
// the same way for a valid link (never reveals whether the email send succeeded).
// Round 6 (feature gap): the dashboard lists the 50 most recent conversions and said "showing 50 of N" with no
// way to see the rest, or to keep a record. Paged (newest first) and read by either token, like the dashboard.
// The page's own CSV export walks it.
async function getPartnerConversions(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(supabase, token, 'id')
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const { limit, offset } = pageParams(ctx)

  const [codesRes, ledgerRes] = await Promise.all([
    supabase.from('referral_codes').select('id, code').eq('partner_id', partner.id),
    supabase.from('commission_ledger')
      .select('id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, payout_id, reverses_ledger_id, reversal_reason, created_at', { count: 'exact' })
      .eq('partner_id', partner.id)
      .order('created_at', { ascending: false }).order('id', { ascending: true })
      .range(offset, offset + limit - 1)
  ])
  if (codesRes.error) throw codesRes.error
  if (ledgerRes.error) throw ledgerRes.error
  const codeTextById = new Map((codesRes.data || []).map(r => [r.id, r.code]))
  return ctx.json({ success: true, total: ledgerRes.count ?? null,
    currency: ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
    data: (ledgerRes.data || []).map(row => conversionRowOf(row, codeTextById)) })
}

async function requestPayoutLink(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  let partner = null
  for (const column of ['dashboard_token', 'payout_details_token']) {
    const { data, error } = await supabase.from('partners')
      .select('name, email, payout_details_token').eq(column, token).maybeSingle()
    if (error) throw error
    if (data) { partner = data; break }
  }
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${partner.payout_details_token}`
  // Own quota key: the partner's button must not share a 4-per-hour budget with admin
  // create/resend of the same template (round 5).
  await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, partner.email, partner.name, payoutUrl, { quotaKey: 'partner_payout_link_self' }).catch(() => {})
  return ctx.json({ success: true, message: 'If your link is valid, we\'ve emailed the payout-details link to the address we have on file.' })
}

// ── Public (token-gated): partner's own email preference ────────────────────
// One email per sale is the default; a busy partner can turn those off. Only the
// per-sale "you earned a commission" email is affected — reversals, payouts, payout-detail
// changes and account notices are never suppressed by this.
const notificationPrefsSchema = z.object({ conversions: z.boolean() })

async function updatePartnerNotifications(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const body = notificationPrefsSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(supabase, token, 'id')
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const { error } = await supabase.from('partners')
    .update({ notify_conversions: body.conversions, updated_at: new Date().toISOString() }).eq('id', partner.id)
  if (error) throw error
  return ctx.json({ success: true, data: { notifyConversions: body.conversions } })
}

const BOT_UA = /bot\b|crawl|spider|slurp|preview|headless|facebookexternalhit|curl\/|wget|python-requests|httpclient|monitor|lighthouse/i

async function trackClick(ctx) {
  const body = await ctx.req.json().catch(() => ({}))
  const code = String(body.code || '').trim().toUpperCase()
  if (!code || code.length > 50) return ctx.json({ success: true })
  const ua = ctx.req.header?.('user-agent') || ''
  if (!ua || BOT_UA.test(ua)) return ctx.json({ success: true })

  const supabase = getSupabase(ctx.env)
  // Round 6 (feature gap / bug): `?ref=` is a generic query parameter (`?ref=producthunt`, `?ref=twitter`), and
  // this always answered success — so the browser stored whatever it was given, overwrote a REAL partner's
  // attribution with junk and showed the buyer "that code doesn't look right". The answer now says whether the
  // code is one that could actually apply (exists, active, unexpired, under its limit, partner active) so the
  // client keeps only those. `valid` is omitted when it can't be determined (lookup failed) — the client then
  // keeps the code, as before.
  let valid
  try {
    valid = isCodeUsable(await lookupCode(supabase, code))
  } catch (err) {
    console.error('trackClick lookup:', err.message)
  }
  if (valid === false) return ctx.json({ success: true, valid: false })
  const { error } = await supabase.rpc('increment_referral_code_clicks', { p_code: code })
  if (error) console.error('trackClick:', error.message)
  return ctx.json(valid === true ? { success: true, valid: true } : { success: true })
}

// ── Public: "become a partner" application ──────────────────────────────────
// Until now the only way in was the owner hand-creating a partner. This is a
// public, rate-limited intake form (partners.routes.js: rl.partnerWrite); the
// admin reviews it under Partners -> Applications and approves (which creates
// the partner and emails their payout-details link) or rejects.
//
// Always answers the same success message for a duplicate or already-a-partner
// email so the form can't be used to probe which addresses are partners.

// Bump when the program terms change in a way applicants must re-accept. Stored with each acceptance.
const PARTNER_TERMS_VERSION = '2026-10'

const applicationSchema = z.object({
  name:     z.string().trim().min(1).max(200),
  email:    z.string().trim().email().max(320),
  audience: z.string().trim().max(1000).optional(),
  website:  z.string().trim().max(300).optional(),
  message:  z.string().trim().max(2000).optional(),
  // Honeypot: real people never see/fill this field.
  company:  z.string().max(200).optional(),
  // Round 6 (feature gap): applying now records acceptance of the program terms (/partner/terms). Required —
  // `true` or the request is refused — so no application exists without one.
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the partner program terms to apply.' }) }),
  // Cloudflare Turnstile token (lib/turnstile.js). Only required when the deployment has
  // TURNSTILE_SECRET_KEY set — same opt-in as the employer-lead and auth forms.
  turnstileToken: z.string().max(2048).nullish()
})

const APPLY_OK = { success: true, message: "Thanks — we've received your application and will email you after we've reviewed it." }

function applicationRowToCamel(row) {
  return {
    id: row.id, name: row.name, email: row.email, audience: row.audience, website: row.website,
    message: row.message, status: row.status, partnerId: row.partner_id,
    reviewNote: row.review_note ?? null,
    termsAcceptedAt: row.terms_accepted_at ?? null, termsVersion: row.terms_version ?? null,
    createdAt: row.created_at, reviewedAt: row.reviewed_at
  }
}

const REAPPLY_COOLDOWN_DAYS = 30

async function applyAsPartner(ctx) {
  const body = applicationSchema.parse(await ctx.req.json())
  if (body.company) return ctx.json(APPLY_OK)   // honeypot tripped — pretend success

  // Round 5: this public form creates a DB row and an owner alert per distinct email, and the
  // alert's dedupe is per applicant address — so only the per-IP limit stood in the way of
  // flooding both. Real error (not fake success) so a person whose widget failed can retry.
  if (!(await verifyTurnstile(ctx.env, body.turnstileToken, clientIp(ctx))))
    return ctx.json({ success: false, code: 'CAPTCHA_FAILED', message: 'We couldn\u2019t verify that you\u2019re human. Please try again.' }, 400)

  const supabase = getSupabase(ctx.env)
  if (await emailUsedByAnotherPartner(supabase, body.email)) return ctx.json(APPLY_OK)

  // Round 4: a rejected applicant could re-submit instantly and forever, re-alerting the
  // owner each time. They were already emailed the decision, so within the cooldown the
  // form just answers the same neutral way without creating anything.
  {
    const exact = String(body.email).replace(/[\\%_]/g, '\\$&')
    const since = new Date(Date.now() - REAPPLY_COOLDOWN_DAYS * 86400000).toISOString()
    const { data: recent, error: recentErr } = await supabase.from('partner_applications')
      .select('id').ilike('email', exact).eq('status', 'REJECTED').gte('reviewed_at', since).limit(1)
    if (recentErr) throw recentErr
    if ((recent || []).length > 0) return ctx.json(APPLY_OK)
  }

  const { error } = await supabase.from('partner_applications').insert({
    name: body.name, email: body.email,
    audience: body.audience || null, website: body.website || null, message: body.message || null,
    terms_accepted_at: new Date().toISOString(), terms_version: PARTNER_TERMS_VERSION
  })
  if (error) {
    if (error.code === '23505') return ctx.json(APPLY_OK)   // already has a pending application
    throw error
  }

  await emailService.sendOwnerAlert(ctx.env, 'New partner application',
    `name: ${body.name}\nemail: ${body.email}\nwebsite: ${body.website || '-'}\n\nReview it under Admin -> Partners -> Applications.`,
    { dedupeKey: body.email.toLowerCase() }).catch(() => {})
  // Round 6: the form promised an email "after review" but the applicant heard nothing until then — and had no
  // way to know the application arrived. Only sent for an application that was actually stored (every silent
  // path above — existing partner, cooldown, duplicate pending — returns before here, so this can't be used to
  // probe which addresses are partners).
  await emailService.sendPartnerApplicationReceived(ctx.env, supabase, body.email, body.name).catch(() => {})
  return ctx.json(APPLY_OK)
}

// Public: the live numbers behind the terms page, so it never states a hold period or minimum that differs from
// what the payout run actually enforces.
async function getProgramTerms(ctx) {
  return ctx.json({ success: true, data: {
    termsVersion:          PARTNER_TERMS_VERSION,
    currency:              ctx.env.PAYSTACK_CURRENCY || c.CURRENCY,
    holdDays:              holdDaysFor(ctx.env),
    minPayoutCents:        minPayoutFor(ctx.env),
    payoutDetailsHoldHours: payoutDetailsHoldHoursFor(ctx.env),
    reapplyCooldownDays:   REAPPLY_COOLDOWN_DAYS
  } })
}

async function adminListApplications(ctx) {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(ctx.req.query('status')) ? ctx.req.query('status') : 'PENDING'
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase.from('partner_applications').select('*')
    .eq('status', status).order('created_at', { ascending: false }).limit(200)
  if (error) throw error
  return ctx.json({ success: true, reapplyCooldownDays: REAPPLY_COOLDOWN_DAYS, data: (data || []).map(applicationRowToCamel) })
}

// Atomic PENDING -> APPROVED claim (a double-click or two admin tabs can't create
// two partners), then the normal partner creation. If creation is refused (the
// email became a partner meanwhile) the claim is put back.
// Round 4: approval used to take no input — the rate was the column default (a second
// PATCH to change it), no code existed until a third request, and the applicant's
// website/audience were dropped on the floor. The optional body now sets the rate and a
// first referral code in the same step, and website/audience are copied onto the partner.
const approveApplicationSchema = z.object({
  commissionRate: z.number().min(0).max(1).optional(),
  referralCode:   createReferralCodeSchema.optional()
})

// Puts a claimed application back to PENDING after a failed approval. If the applicant already filed a NEW pending
// application in the meantime the unique pending-per-email index refuses the restore; this one is then closed as
// superseded rather than left APPROVED with no partner behind it.
async function restoreApplicationToPending(supabase, appId) {
  const { error } = await supabase.from('partner_applications').update({ status: 'PENDING', reviewed_at: null }).eq('id', appId)
  if (error) {
    if (error.code === '23505')
      await supabase.from('partner_applications')
        .update({ status: 'REJECTED', reviewed_at: new Date().toISOString(), review_note: 'Superseded by a newer application from the same email.' })
        .eq('id', appId)
    else console.error('restoreApplicationToPending:', error.message)
  }
}

async function adminApproveApplication(ctx) {
  const appId = ctx.req.param('id')
  const body = approveApplicationSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)

  // Check the code is free BEFORE claiming the application, so a duplicate code is a
  // clean 400 rather than a half-finished approval.
  const firstCode = body.referralCode ? body.referralCode.code.trim().toUpperCase() : null
  if (firstCode) {
    const { data: taken, error: takenErr } = await supabase.from('referral_codes').select('id').eq('code', firstCode).limit(1)
    if (takenErr) throw takenErr
    if ((taken || []).length > 0)
      return ctx.json({ success: false, message: `The code ${firstCode} already exists — pick another.` }, 400)
  }

  // Round 6 (bug): the "email already belongs to a partner" refusal used to happen AFTER the application was
  // flipped to APPROVED, then flipped back — a window in which the applicant could re-apply (the pending-per-email
  // index no longer applied) and the flip back would hit that index, stranding this application APPROVED with no
  // partner. Look first; only claim an application that can actually become a partner.
  {
    const { data: pending, error: pendingErr } = await supabase.from('partner_applications')
      .select('email').eq('id', appId).eq('status', 'PENDING').maybeSingle()
    if (pendingErr) throw pendingErr
    if (pending && await emailUsedByAnotherPartner(supabase, pending.email))
      return ctx.json({ success: false, message: 'A partner with that email address already exists.' }, 400)
  }

  const { data: claimed, error } = await supabase.from('partner_applications')
    .update({ status: 'APPROVED', reviewed_at: new Date().toISOString() })
    .eq('id', appId).eq('status', 'PENDING').select('*').maybeSingle()
  if (error) throw error
  if (!claimed) return ctx.json({ success: false, message: 'Application not found or already reviewed.' }, 404)

  let made
  try {
    made = await createPartnerRecord(ctx, supabase,
      { name: claimed.name, email: claimed.email, commissionRate: body.commissionRate, website: claimed.website, audience: claimed.audience,
        termsAcceptedAt: claimed.terms_accepted_at, termsVersion: claimed.terms_version },
      'partner.create', { fromApplication: appId })
  } catch (err) {
    await restoreApplicationToPending(supabase, appId)
    throw err
  }
  if (made.error) {
    await restoreApplicationToPending(supabase, appId)
    return ctx.json({ success: false, message: made.error }, 400)
  }
  await supabase.from('partner_applications').update({ partner_id: made.data.id }).eq('id', appId)

  // The partner exists and has been emailed by now, so a failure here is reported, not
  // rolled back: the admin can add the code from the partner page.
  let codeCreated = null, codeError = null
  if (body.referralCode) {
    const { data: codeRow, error: codeErr } = await supabase.from('referral_codes').insert({
      partner_id: made.data.id, code: firstCode, tier_prices: body.referralCode.tierPrices,
      usage_limit: body.referralCode.usageLimit || null, expires_at: body.referralCode.expiresAt || null
    }).select('*').single()
    if (codeErr) { codeError = codeErr.code === '23505' ? `The code ${firstCode} already exists.` : 'The first code could not be created.' }
    else {
      codeCreated = referralCodeRowToCamel(codeRow)
      await emailService.sendReferralCodeCreated(ctx.env, supabase, made.data.email, made.data.name, codeRow.code,
        `${ctx.env.FRONTEND_URL}/partner/dashboard?token=${made.data.dashboard_token}`).catch(() => {})
      await logAdminAction(ctx, supabase, 'partner.referral_code_created', 'referral_code', codeRow.id, {
        partnerId: made.data.id, code: codeRow.code, tierPrices: codeRow.tier_prices, fromApplication: appId
      })
    }
  }
  await logAdminAction(ctx, supabase, 'partner.application_approved', 'partner_application', appId, { partnerId: made.data.id, commissionRate: made.data.commission_rate })
  return ctx.json({ success: true, data: partnerRowToCamel(made.data), codeCreated, codeError, emailed: made.emailed, ...(made.payoutUrl ? { payoutUrl: made.payoutUrl } : {}) })
}

const rejectApplicationSchema = z.object({ reason: z.string().trim().max(500).optional() })

async function adminRejectApplication(ctx) {
  const appId = ctx.req.param('id')
  const body = rejectApplicationSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase.from('partner_applications')
    .update({ status: 'REJECTED', reviewed_at: new Date().toISOString(), review_note: body.reason || null })
    .eq('id', appId).eq('status', 'PENDING').select('id, name, email').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Application not found or already reviewed.' }, 404)
  // Round 4 (bug): the apply form promises "we'll email you after we've reviewed it", but
  // only approval ever sent anything — a rejected applicant just never heard back.
  const emailed = await emailService.sendPartnerApplicationRejected(ctx.env, supabase, data.email, data.name, body.reason || null, REAPPLY_COOLDOWN_DAYS)
    .catch(() => false)
  await logAdminAction(ctx, supabase, 'partner.application_rejected', 'partner_application', appId, { hasReason: !!body.reason, emailed })
  return ctx.json({ success: true, emailed })
}

// ── Admin: void a payout recorded in error ──────────────────────────────────
// Recording was one-way: a wrong amount / partner / cycle meant hand-written SQL. Voiding
// keeps the payout row (audit trail) with voided_at set and RELEASES the ledger rows it
// settled (payout_id back to NULL), so the commission is owed again and every payable /
// pending / dashboard figure — all derived from ledger.payout_id — corrects itself.
// Idempotent and resumable: the claim is atomic, and the release step is re-run on a repeat
// call, so a failure between the two can simply be retried.
const voidPayoutSchema = z.object({
  reason:        z.string().trim().min(3, 'Say why this payout is being voided.').max(300),
  notifyPartner: z.boolean().optional()
})

async function adminVoidPayout(ctx) {
  const partnerId = ctx.req.param('id')
  const payoutId  = ctx.req.param('payoutId')
  const body = voidPayoutSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)

  const { data: payout, error } = await supabase.from('payouts')
    .select('id, partner_id, amount_cents, currency, voided_at')
    .eq('id', payoutId).eq('partner_id', partnerId).maybeSingle()
  if (error) throw error
  if (!payout) return ctx.json({ success: false, message: 'Payout not found.' }, 404)

  let alreadyVoided = !!payout.voided_at
  if (!alreadyVoided) {
    const { data: claimed, error: claimErr } = await supabase.from('payouts')
      .update({ voided_at: new Date().toISOString(), void_reason: body.reason })
      .eq('id', payoutId).is('voided_at', null).select('id').maybeSingle()
    if (claimErr) throw claimErr
    if (!claimed) alreadyVoided = true   // a concurrent void won the claim; just finish the release
  }

  const { data: released, error: relErr } = await supabase.from('commission_ledger')
    .update({ payout_id: null }).eq('payout_id', payoutId).select('id')
  if (relErr) {
    console.error('adminVoidPayout ledger release:', relErr.message)
    return ctx.json({ success: false,
      message: 'The payout was marked void, but releasing its commission rows failed. Run "Void" again to finish — the commission is not owed again until that succeeds.' }, 500)
  }

  if (!alreadyVoided) {
    await logAdminAction(ctx, supabase, 'partner.payout_voided', 'payout', payoutId, {
      partnerId, amountCents: payout.amount_cents, releasedRows: (released || []).length, reason: body.reason
    })
    if (body.notifyPartner !== false) {
      const { data: partner } = await supabase.from('partners').select('name, email').eq('id', partnerId).maybeSingle()
      if (partner) await emailService.sendPartnerPayoutVoided(ctx.env, supabase, partner.email, partner.name,
        payout.amount_cents, payout.currency, null).catch(() => {})
    }
  }
  return ctx.json({ success: true, alreadyVoided, releasedCount: (released || []).length,
    message: alreadyVoided ? 'Payout was already void — commission rows confirmed released.' : 'Payout voided — its commission is owed again.' })
}

// ── Admin: cross-partner lookups ────────────────────────────────────────────
// adminListPartners deliberately ships no codes or payout history (scale), which left
// "who owns code X?" and "what did we pay in September?" needing a click through every
// partner. These are paged, read-only views over the same tables.
// Backslash is Postgres's default LIKE escape: `_` is common in codes and must match literally.
const LIKE_ESCAPE = v => String(v).trim().replace(/[\\%_]/g, '\\$&')
const pageParams = ctx => {
  const limit  = Math.min(Math.max(parseInt(ctx.req.query('limit'), 10)  || 50, 1), 200)
  const offset = Math.max(parseInt(ctx.req.query('offset'), 10) || 0, 0)
  return { limit, offset }
}

async function adminListReferralCodes(ctx) {
  const supabase = getSupabase(ctx.env)
  const { limit, offset } = pageParams(ctx)
  const q = LIKE_ESCAPE(String(ctx.req.query('q') || '').slice(0, 50)).toUpperCase()
  let query = supabase.from('referral_codes')
    .select('id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at, partners(name, email, status)', { count: 'exact' })
  if (q) query = query.ilike('code', `%${q}%`)
  const active = ctx.req.query('active')
  if (active === 'true' || active === 'false') query = query.eq('active', active === 'true')
  const partnerId = ctx.req.query('partnerId')
  if (partnerId && UUID_RE.test(partnerId)) query = query.eq('partner_id', partnerId)
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, data: (data || []).map(r => ({
    ...referralCodeRowToCamel(r),
    partnerName: r.partners?.name ?? null, partnerEmail: r.partners?.email ?? null, partnerStatus: r.partners?.status ?? null
  })) })
}

async function adminListPayouts(ctx) {
  const supabase = getSupabase(ctx.env)
  const { limit, offset } = pageParams(ctx)
  let query = supabase.from('payouts')
    .select('id, partner_id, amount_cents, currency, payout_method, note, internal_note, settled_commission_cents, period_start, period_end, paid_at, created_at, voided_at, void_reason, partners(name, email)', { count: 'exact' })
  if (ctx.req.query('includeVoided') !== 'true') query = query.is('voided_at', null)
  const partnerId = ctx.req.query('partnerId')
  if (partnerId && UUID_RE.test(partnerId)) query = query.eq('partner_id', partnerId)
  const from = ctx.req.query('from'), to = ctx.req.query('to')
  if (from && !Number.isNaN(Date.parse(from))) query = query.gte('paid_at', new Date(from).toISOString())
  if (to && !Number.isNaN(Date.parse(to)))     query = query.lte('paid_at', new Date(to).toISOString())
  const { data, error, count } = await query.order('paid_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, currency: ctx.env.PAYSTACK_CURRENCY || c.CURRENCY, data: (data || []).map(r => ({
    ...payoutRowToCamel(r), partnerName: r.partners?.name ?? null, partnerEmail: r.partners?.email ?? null
  })) })
}

// Pages through one numeric column so a total is never silently cut at PostgREST's row cap.
async function sumPaged(makeQuery, column) {
  let total = 0
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().order('id', { ascending: true }).range(from, from + 999)
    if (error) throw error
    for (const r of data || []) total += Number(r[column]) || 0
    if (!data || data.length < 1000) break
  }
  return total
}

async function adminPartnersOverview(ctx) {
  const supabase = getSupabase(ctx.env)
  const head = (table, apply) => apply(supabase.from(table).select('id', { count: 'exact', head: true }))
  const [partnersRes, activeRes, pendingAppsRes, paidOutCents, owedCents, earnedCents] = await Promise.all([
    head('partners', q => q),
    head('partners', q => q.eq('status', 'ACTIVE')),
    head('partner_applications', q => q.eq('status', 'PENDING')),
    sumPaged(() => supabase.from('payouts').select('id, amount_cents').is('voided_at', null), 'amount_cents'),
    sumPaged(() => supabase.from('commission_ledger').select('id, commission_amount_cents').is('payout_id', null), 'commission_amount_cents'),
    sumPaged(() => supabase.from('commission_ledger').select('id, commission_amount_cents'), 'commission_amount_cents')
  ])
  for (const r of [partnersRes, activeRes, pendingAppsRes]) if (r.error) throw r.error
  return ctx.json({ success: true, data: {
    partners: partnersRes.count ?? 0, activePartners: activeRes.count ?? 0, pendingApplications: pendingAppsRes.count ?? 0,
    paidOutCents, owedCents, lifetimeCommissionCents: earnedCents,
    currency: ctx.env.PAYSTACK_CURRENCY || c.CURRENCY
  } })
}

module.exports = {
  buildCyclesSummary,
  adminCreatePartner, adminUpdatePartner, adminListPartners, adminGetPartner,
  adminResendPayoutLink, adminRegeneratePayoutLink, adminGetPartnerLinks, adminRecordPayout,
  adminCreateReferralCode, adminUpdateReferralCode, adminVoidPayout, adminRecordPayoutBatch,
  adminListReferralCodes, adminListPayouts, adminPartnersOverview,
  getPartnerByToken, submitPayoutDetails, getPartnerDashboard, getPartnerConversions, getProgramTerms, requestPayoutLink, updatePartnerNotifications, trackClick,
  applyAsPartner, adminListApplications, adminApproveApplication, adminRejectApplication
}
