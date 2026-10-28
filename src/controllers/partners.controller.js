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
const payoutRails = require('../lib/payoutRails')
const fieldCrypto = require('../lib/fieldCrypto')
const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')

// The payout link is the WRITE capability of the programme, so — like every other bearer token (reset, verify, anon scan) — it
// is stored as a sha256 (migration 0087, partners.payout_token_hash). payout_details_token is always written null; the raw token
// exists only in the link that was emailed. Lookups hash what a visitor presents.
const payoutTokenFields = async (rawToken) => ({ payout_details_token: null, payout_token_hash: await cryptoLib.sha256(rawToken) })

// Presented token -> [column, value] for an exact-match lookup. Payout tokens are matched on their hash.
const partnerLinks = require('../lib/partnerLinks')

async function tokenLookup(column, token) {
  return column === 'payout_details_token' ? ['payout_token_hash', await cryptoLib.sha256(token)] : [column, token]
}

// A stored hash cannot be turned back into a link, so "send / show the payout link" mints a fresh token (the old
// link stops working — the same effect as the admin Regenerate button) and returns the raw token for that one use.
async function issuePayoutToken(supabase, partnerId) {
  const raw = cryptoLib.randomToken(32)
  const { error } = await supabase.from('partners')
    .update({ ...(await payoutTokenFields(raw)), updated_at: new Date().toISOString() }).eq('id', partnerId)
  if (error) throw error
  return raw
}
const emailService = require('../services/email.service')
const { recentCycles, cycleKey } = require('../lib/cycles')
const { normalizeSub } = require('../lib/referralSub')
const { logAdminAction } = require('../lib/adminAudit')
const { verifyTurnstile } = require('../lib/turnstile')
const { clientIp } = require('../lib/clientIp')
const { runInBackground } = require('../lib/background')
const { REMOVED_EMAIL_DOMAIN, isRemovedEmail } = require('../lib/removedPartner')
const { UUID_RE } = require('../middleware/validateUuidParam')
const referralService = require('../services/referral.service')
const { lookupCode, isCodeUsable } = referralService
// Round 29: the internal partner that owns every personal welcome code (migration 0105; 0% rate, never paid, never mailed). It is
// a plumbing row, not a partner: it is left out of every partner list / total / sweep and refused by every admin action that
// would edit, pause, erase or pay it (pausing or erasing it would switch off every welcome code).
const WELCOME_PARTNER_ID = c.WELCOME_PARTNER_ID
const isSystemPartnerId = id => !!id && String(id).toLowerCase() === WELCOME_PARTNER_ID
const systemPartnerResponse = ctx => ctx.json({ success: false, code: 'SYSTEM_PARTNER',
  message: 'This is the internal record that owns the welcome codes. It cannot be edited, paused, paid or erased from here.' }, 409)
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

// Unpaid commission per currency. Cents of different currencies must never be added together: the admin screens flag a partner whose
// unpaid ledger spans currencies (the platform currency was changed), and the partner's own pages now say so too. A row with no
// currency of its own belongs to the platform currency.
function unpaidByCurrency(ledgerRows, fallbackCurrency) {
  const out = {}
  for (const l of ledgerRows || []) {
    if (l.payout_id) continue
    const cur = String(l.currency || fallbackCurrency).toUpperCase()
    out[cur] = (out[cur] || 0) + (Number(l.commission_amount_cents) || 0)
  }
  return out
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
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')   // strict: "7d" / "1e3" -> default 0, never a prefix
  return numEnv(env?.COMMISSION_HOLD_DAYS, 0, NUMERIC_ENV.COMMISSION_HOLD_DAYS)
}
// A commission on a payment that is currently DISPUTED (a chargeback is open) is
// held regardless of the age window: if the dispute is lost the sale is reversed
// and the commission clawed back, so paying it out first just creates a debt.
// Needs the ledger select to embed `payments(status)`.
function isHeldRow(row, holdDays, now = Date.now()) {
  // A manual adjustment is never held: it is the admin's own decision, not a sale a refund could still undo.
  if (row.payout_id || row.reverses_ledger_id || row.kind === 'ADJUSTMENT') return false
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
// Partners round 38: opt-in switch, off by default so nothing changes until the owner turns it on.
function payoutRequiresCurrentTerms(env) {
  return String((env && env.PAYOUT_REQUIRES_CURRENT_TERMS) || '').trim() === '1'
}
function payoutDetailsHoldHoursFor(env) {
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')   // strict: "0.5" used to parse as 0 = hold OFF; now malformed -> 48
  return numEnv(env?.PAYOUT_DETAILS_HOLD_HOURS, 48, NUMERIC_ENV.PAYOUT_DETAILS_HOLD_HOURS)
}

function minPayoutFor(env) {
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')   // strict: "2000c" / "1e3" -> default 0 (off), never a prefix
  return numEnv(env?.COMMISSION_MIN_PAYOUT_CENTS, 0, NUMERIC_ENV.COMMISSION_MIN_PAYOUT_CENTS)
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
// conversions = originals that have not been reversed. A manual adjustment (round 8, migration 0069) is
// not a sale and never counts as a conversion.
function netConversionCount(ledgerRows) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  return rows.filter(l => l.kind !== 'ADJUSTMENT' && !l.reverses_ledger_id && !reversed.has(l.id)).length
}

// A "credit" row is one that is not a sale of its own and is settled by whichever closed-cycle payout comes
// next: a refund reversal, or a manual adjustment (either sign). Cycle-scoped payouts pull every unpaid one
// from a closed cycle in with them (recordPayoutCore), and buildCyclesSummary reports the part that lives
// outside a cycle's own window so the Pay button's default amount matches what the server will settle.
const isCreditRow = l => !!l.reverses_ledger_id || l.kind === 'ADJUSTMENT'

// Per-code performance: net conversions, net gross revenue and commission
// (reversal rows are negative, so plain sums already net out).
function buildCodeStats(ledgerRows, codes) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  // Round 41 (bug): a partial refund is an ADJUSTMENT row, and the ledger constraint (kind_shape) forbids it carrying a code, so it never
  // reached any code's earnings: a code that had refunded part of a sale still showed the full commission, on the partner dashboard and
  // in admin. It now counts against the code of the sale it adjusts (adjusts_ledger_id). A manual adjustment adjusts no sale and, as
  // before, belongs to no code. An adjustment is money only: it is never a conversion.
  const codeOfSale = new Map()
  for (const l of rows) if (l.referral_code_id) codeOfSale.set(l.id, l.referral_code_id)
  const out = {}
  for (const code of codes || []) out[code.id] = { conversions: 0, grossCents: 0, commissionCents: 0 }
  for (const l of rows) {
    const codeId = l.referral_code_id || (l.adjusts_ledger_id ? codeOfSale.get(l.adjusts_ledger_id) : null)
    const b = out[codeId]
    if (!b) continue
    b.grossCents += l.gross_amount_cents || 0
    b.commissionCents += l.commission_amount_cents
    if (l.kind !== 'ADJUSTMENT' && !l.reverses_ledger_id && !reversed.has(l.id)) b.conversions += 1
  }
  return out
}
function attachCodeStats(camelCodes, ledgerRows, rawCodes) {
  const stats = buildCodeStats(ledgerRows, rawCodes)
  return (camelCodes || []).map(rc => {
    const st = stats[rc.id] || { conversions: 0, grossCents: 0, commissionCents: 0 }
    // Section 4 round 7 (bug): sales made with a TYPED code never produce a click, and one click can buy more
    // than once, so sales can exceed clicks and the ratio read "250% of clicks bought". A rate above 100% is not
    // a conversion rate — report none instead of a wrong one.
    const rate = rc.clicks > 0 && st.conversions <= rc.clicks ? st.conversions / rc.clicks : null
    return { ...rc, stats: { ...st, conversionRate: rate } }
  })
}
// Section 4 round 13 (feature gap): the funnel stopped at "clicks" and "sales", so a partner whose link was being visited and
// whose visitors were registering, but not yet buying, saw no sign of it. The middle step is how many accounts are CURRENTLY
// attributed to the code (users.referred_by_code, migration 0079): aggregate counts only, never who. Head-only counts per
// code (a partner has a handful of codes); a failed count leaves `signups` null so the page omits the step instead of showing 0.
async function attachSignupCounts(supabase, codes) {
  const list = codes || []
  if (!list.length) return list
  // Round 20 (scale): this used to run one COUNT per code (a Worker subrequest each, on every dashboard / partner-detail load).
  // One grouped call answers for all of them; a failure leaves `signups` null so the page omits the step instead of showing 0.
  try {
    const since = new Date(Date.now() - c.REFERRAL_ATTRIBUTION_DAYS * 24 * 3600 * 1000).toISOString()
    const { data, error } = await supabase.rpc('referral_signup_counts', { p_codes: list.map(rc => rc.code), p_since: since })
    if (error) throw error
    const byCode = new Map((data || []).map(r => [r.code, Number(r.signups) || 0]))
    return list.map(rc => ({ ...rc, signups: byCode.get(rc.code) ?? 0 }))
  } catch (err) {
    console.error('attachSignupCounts:', err.message)
    return list.map(rc => ({ ...rc, signups: null }))
  }
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
    heldDisputeCents: 0, heldUntilMs: 0,
    ledgerCount: 0, payoutIds: new Set()
  }]))

  // Round 5: unpaid refund CREDITS (a reversal whose original was already paid) from CLOSED
  // cycles. A cycle-scoped payout settles all of them with it (adminRecordPayout), so each
  // cycle reports the part that lives OUTSIDE its own window — what the Pay button's default
  // amount must add to unpaidCents to match what the server will actually settle.
  let closedCreditCents = 0
  const creditByKey = new Map()
  for (const row of rows) {
    if (row.payout_id || !isCreditRow(row) || voided.has(row.id)) continue
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
    if (row.kind !== 'ADJUSTMENT' && !row.reverses_ledger_id && !reversedIds.has(row.id)) bucket.ledgerCount += 1
    if (row.payout_id) {
      bucket.paidCents += row.commission_amount_cents
      bucket.payoutIds.add(row.payout_id)
    } else if (!voided.has(row.id)) {
      bucket.unpaidCents += row.commission_amount_cents
      if (isHeldRow(row, holdDays)) {
        bucket.heldCents += row.commission_amount_cents
        // Round 20: WHEN does it free up? An open dispute has no date; an age hold ends holdDays after the sale.
        if (row.payments?.status === 'DISPUTED') bucket.heldDisputeCents += row.commission_amount_cents
        else bucket.heldUntilMs = Math.max(bucket.heldUntilMs, Date.parse(row.created_at) + holdDays * 86400000)
      }
    }
  }

  return cycles.map(c => {
    const b = byKey.get(c.key)
    return { ...c, grossCents: b.grossCents, commissionCents: b.commissionCents,
      unpaidCents: b.unpaidCents, paidCents: b.paidCents, heldCents: b.heldCents,
      heldDisputeCents: b.heldDisputeCents, heldUntil: b.heldUntilMs ? new Date(b.heldUntilMs).toISOString() : null,
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

// Section 4 round 13 (bug): `<anything>@removed.invalid` is the placeholder an anonymized partner row is rewritten to
// (adminAnonymizePartner). Nothing stopped an application, an admin-created partner or an email edit from using it, which
// made a LIVE partner indistinguishable from an erased one: every send to it is silently suppressed (email.service) and
// every token endpoint answers "invalid link". Same rule signup already applies (auth.controller signupEmailSchema).
const partnerEmailSchema = z.string().trim().email().max(320)
  .refine(e => !isRemovedEmail(e), { message: 'That email address can\u2019t be used.' })

const createPartnerSchema = z.object({
  name:  z.string().trim().min(1).max(200),
  email: partnerEmailSchema,
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

// Section 4 round 9 (bug): only adminUpdatePartner (and the ledger adjustment) refused an anonymized partner. Resend /
// regenerate / view-links / create-code / re-activate-code all still worked on one, which mints a live bearer link (or
// an active discount code) for a record whose owner asked to be erased — and hands the admin a working write-link to a
// row with no identity.
const partnerRemovedResponse = ctx => ctx.json({ success: false, code: 'PARTNER_REMOVED',
  message: "This partner's personal data was removed, so no links or codes can be issued for the record." }, 409)

// Shared by adminCreatePartner and application approval so both create a partner
// the same way. Returns { error: message } for a duplicate email, else { data }.
async function createPartnerRecord(ctx, supabase, { name, email, commissionRate, website, audience, termsAcceptedAt, termsVersion }, auditAction = 'partner.create', auditExtra = {}) {
  if (await emailUsedByAnotherPartner(supabase, email))
    return { error: 'A partner with that email address already exists.' }

  // Two independent bearer tokens: payout_details_token (WRITE — changes where money
  // goes; only ever mailed on its own) and the dashboard link (READ-ONLY, derived — see lib/partnerLinks.js — what the
  // conversion/reversal/code notification emails carry). See migration 0055.
  const token = cryptoLib.randomToken(32)

  const { data, error } = await supabase.from('partners').insert({
    name, email, ...(await payoutTokenFields(token)),
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
  email:          partnerEmailSchema.optional(),
  status:         z.enum(['ACTIVE', 'PAUSED', 'ENDED']).optional(),
  // Fraction, not a percentage integer — 0.25 = 25%, matching 0012's
  // commission_rate comment. Bounded 0-1 here at the API boundary; the
  // same bound also exists as a DB-level CHECK (see migration 0015) as a
  // backstop for any future write path that doesn't go through this Zod
  // schema.
  commissionRate: z.number().min(0).max(1).optional(),
  // Round 8 (feature gap): the profile an applicant typed could never be corrected after approval, and an
  // admin-created partner could never be given one. '' or null clears the field. internalNotes is admin-only:
  // no token-gated partner endpoint selects it.
  website:        z.string().trim().max(300).nullable().optional(),
  audience:       z.string().trim().max(1000).nullable().optional(),
  internalNotes:  z.string().trim().max(2000).nullable().optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one field is required.')

const PROFILE_FIELDS = [['website', 'website'], ['audience', 'audience'], ['internalNotes', 'internal_notes']]

async function adminUpdatePartner(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const body = updatePartnerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  // AUDIT FIX (feature gap): need the OLD email AND status before they're
  // overwritten, so both notifications below have something to compare against.
  // Section 4 round 7 (bug): this read's error was dropped, so a failed read let an email change through with
  // `before` empty — no token rotation, no partner/owner alert, no audit entry. The three safeguards all hang
  // off `before`, so a failed read now fails the request (the admin retries) instead of skipping them.
  const { data: before, error: beforeErr } = await supabase.from('partners').select('id, email, status, commission_rate, previous_emails, dashboard_token_version').eq('id', partnerId).maybeSingle()
  if (beforeErr) throw beforeErr
  if (!before) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  // A partner whose data was removed stays removed: re-activating the row or giving it a real address would
  // quietly undo the erasure (and start mailing new links to whoever was typed in).
  if (isRemovedEmail(before.email))
    return ctx.json({ success: false, code: 'PARTNER_REMOVED', message: "This partner's personal data was removed, so the record can't be edited." }, 409)

  // Section 10 audit: see emailUsedByAnotherPartner above. Only queried when
  // the address actually changes (case-insensitively), not on every save.
  if (body.email !== undefined && (!before?.email || body.email.toLowerCase() !== before.email.toLowerCase())) {
    if (await emailUsedByAnotherPartner(supabase, body.email, partnerId))
      return ctx.json({ success: false, message: 'A partner with that email address already exists.' }, 400)
  }

  const patch = camelToSnake(body, PARTNER_FIELD_MAP)  // status, commissionRate
  if (body.name !== undefined)  patch.name = body.name
  if (body.email !== undefined) patch.email = body.email
  const profileEdited = []
  for (const [key, column] of PROFILE_FIELDS) {
    if (body[key] === undefined) continue
    patch[column] = body[key] === null || body[key] === '' ? null : body[key]
    profileEdited.push(key)
  }
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
  const dashRotation = emailChanging ? partnerLinks.rotateDashboardPatch(before) : null
  if (rotatedToken) { Object.assign(patch, await payoutTokenFields(rotatedToken), dashRotation) }
  // Round 11 (bug): erasure could only clean the CURRENT address from the mail history. Keep the ones a partner
  // used to have (lower-cased, de-duplicated) so adminAnonymizePartner can clean them too; cleared on erasure.
  if (emailChanging) {
    const prev = Array.isArray(before.previous_emails) ? before.previous_emails : []
    patch.previous_emails = [...new Set([...prev, before.email].map(e => String(e).trim().toLowerCase()).filter(Boolean))].slice(-20)
  }
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
  // Round 22: the old links died with the address change and the new ones go ONLY to the new address, so a failed send used to
  // leave the partner with no working link while the admin saw a plain success. The outcome is reported (and the links handed
  // back on failure, like create/approve do) so the admin can pass them on by hand.
  let linksEmailed = true
  if (rotatedToken) {
    const payoutLinkSent = await emailService.sendPartnerLinkRegenerated(ctx.env, supabase, data.email, data.name,
      `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${rotatedToken}`).catch(() => false)
    // Round 11 (gap): the dashboard link was rotated too, but only the payout link reached the new address.
    const dashLinkSent = await emailService.sendPartnerDashboardLinkRegenerated(ctx.env, supabase, data.email, data.name,
      await partnerLinks.dashboardUrlOf(ctx.env, data)).catch(() => false)
    linksEmailed = payoutLinkSent !== false && dashLinkSent !== false
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
      profileEdited.length ||
      (body.status !== undefined && before?.status && before.status !== data.status)) {
    await logAdminAction(ctx, supabase, 'partner.update', 'partner', partnerId, {
      emailChanged: emailChanging,
      // Field NAMES only - the notes and profile text are not copied into the audit log.
      ...(profileEdited.length ? { profileEdited } : {}),
      ...(rotatedToken ? { payoutLinkRotated: true } : {}),
      ...(rateChanging ? { rateFrom: Number(before.commission_rate), rateTo: Number(data.commission_rate) } : {}),
      ...(body.status !== undefined && before?.status !== data.status
        ? { statusFrom: before.status, statusTo: data.status } : {})
    })
  }

  // A name / status / profile edit needs no step-up, so its response must not carry what the step-up protects: the full
  // account number and tax ID stay out, exactly as in the partner list.
  const updatedCamel = partnerRowToCamel(data)
  updatedCamel.payoutDetails = maskedPayoutDetailsForOwner(data.payout_method, data.payout_details)
  updatedCamel.taxId = data.tax_id ? (last4Of(await fieldCrypto.openTaxId(ctx.env, data.tax_id)) || null) : null
  updatedCamel.detailsMasked = true
  return ctx.json({ success: true, data: updatedCamel,
    ...(rotatedToken ? { linksEmailed } : {}),
    ...(rotatedToken && !linksEmailed ? {
      payoutUrl: `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${rotatedToken}`,
      dashboardUrl: await partnerLinks.dashboardUrlOf(ctx.env, data)
    } : {}) })
}

// ── Admin: list all partners + a light cycle summary + pending balance ─────
// Deliberately does NOT ship the full commission_ledger to the browser here
// (it used to — fetched on every list load and never rendered anywhere).
// The list view only needs enough to answer "who's owed something and how
// much is actually ready to pay right now" — the full ledger (for the
// Conversions tab) lives behind adminGetPartner, fetched only when someone
// opens that partner's detail page.

// Section 4 round 9 (feature gap): the only sign that a partner's setup email bounced or was throttled was a
// console line and an email_logs row nobody reads, so a partner could sit with no payout details for weeks while
// the admin assumed the link had arrived. For partners who have not set details up yet, report how the LATEST
// payout-link email went. Best-effort — a failed lookup just omits the field.
async function latestPayoutLinkEmailStatus(supabase, emails) {
  const out = new Map()
  const CHUNK = 40
  try {
    for (let i = 0; i < emails.length; i += CHUNK) {
      const slice = emails.slice(i, i + CHUNK)
      const { data, error } = await supabase.from('email_logs')
        .select('to, status, sent_at').eq('template', 'partner_payout_details_request').in('to', slice)
        .order('sent_at', { ascending: false }).limit(CHUNK * 10)
      if (error) { console.error('latestPayoutLinkEmailStatus:', error.message); continue }
      for (const r of data || []) {
        const key = String(r.to || '').toLowerCase()
        if (!out.has(key)) out.set(key, { status: r.status, sentAt: r.sent_at })
      }
    }
  } catch (err) { console.error('latestPayoutLinkEmailStatus:', err.message) }
  return out
}

// Every partner row, paged so PostgREST's row cap (1000) cannot silently drop partners from the admin list, the payout-run
// export or the payout-due alert. `build` receives the bare table query and returns it with columns/filters applied.
async function loadAllPartners(supabase, build) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(supabase.from('partners')).neq('id', WELCOME_PARTNER_ID)
      .order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

// Every UNPAID ledger row, grouped by partner (paged so PostgREST's row cap can't truncate it). Shared by the
// admin list and the payout-due reminder so both judge "ready to pay" from the same rows.
// Round 27: one partner's WHOLE ledger, read in keyset pages instead of an embedded sub-select. The embed returned every row in a
// single response (no bound, and a silent cut-off wherever PostgREST's row cap applies - which would make every total wrong),
// while stats must see all rows. Newest first, id as the tiebreak: the order /conversions pages in.
async function loadLedgerForPartner(supabase, partnerId, columns) {
  const PAGE = 1000, rows = []
  let last = null
  for (let page = 0; page < 500; page += 1) {
    let q = supabase.from('commission_ledger').select(columns).eq('partner_id', partnerId)
    if (last) q = q.gt('id', last)
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGE)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
    last = data[data.length - 1].id
  }
  return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? -1 : 1)))
}

const UNPAID_LEDGER_MAX_PAGES = 40
async function loadUnpaidLedgerByPartner(supabase) {
  const ledgerByPartner = new Map()
  const PAGE = 1000
  // Partners round 38: the admin list, the payout export and the hourly sweep all read EVERY unpaid row, one request per 1,000. Past the
  // Worker's subrequest ceiling that surfaced as an opaque 500 in the middle of a payout run. The ceiling is now ours: well below the
  // platform's, logged as it nears, and refused with a message that says what to do.
  let pages = 0
  // Round 27 (bug): this paged with range() over a filter (payout_id is null) that SHRINKS whenever a payout is recorded, so a
  // payout landing mid-scan shifted every later page and silently skipped rows. Keyset paging on the primary key is immune.
  let last = null
  for (;;) {
    let q = supabase
      .from('commission_ledger')
      .select('id, partner_id, gross_amount_cents, commission_amount_cents, payout_id, reverses_ledger_id, kind, currency, created_at, payments(status)')
      .is('payout_id', null)
      // Round 29: the welcome-code partner writes a 0-cent row per redemption that no payout ever settles; read on every admin
      // list, payout export and hourly sweep it grew without bound. A zero row carries no money, so it is left out of these figures.
      .neq('partner_id', WELCOME_PARTNER_ID).neq('commission_amount_cents', 0)
    if (last) q = q.gt('id', last)
    const { data: rows, error: lerr } = await q.order('id', { ascending: true }).limit(PAGE)
    if (lerr) throw lerr
    pages += 1
    if (pages === Math.floor(UNPAID_LEDGER_MAX_PAGES / 2)) console.warn(`loadUnpaidLedgerByPartner: ${pages * PAGE}+ unpaid ledger rows - record payouts or move this scan into SQL before it reaches ${UNPAID_LEDGER_MAX_PAGES * PAGE}`)
    if (pages > UNPAID_LEDGER_MAX_PAGES) {
      const err = new Error(`More than ${UNPAID_LEDGER_MAX_PAGES * PAGE} unpaid commission rows - settle older commissions (record the pending payouts) before using this view.`)
      err.code = 'UNPAID_LEDGER_TOO_LARGE'
      throw err
    }
    for (const r of rows || []) {
      if (!ledgerByPartner.has(r.partner_id)) ledgerByPartner.set(r.partner_id, [])
      ledgerByPartner.get(r.partner_id).push(r)
    }
    if (!rows || rows.length < PAGE) break
    last = rows[rows.length - 1].id
  }
  return ledgerByPartner
}

// Section 4 round 11 (feature gap): cycles close on the 1st and 16th (UTC) and nothing told the owner a payout run
// was due - it relied on remembering to open the admin panel. Once per closed cycle (hourly sweep, KV-guarded) the
// owner gets ONE alert: how many partners are ready, the total, and how much is still held or lacks payout details.
// No names or addresses in the message (the alert history is erased partner-by-partner on removal).
async function sweepPayoutDue(env, supabase) {
  const out = { sent: false, ready: 0, readyCents: 0, waiting: 0, waitingCents: 0 }
  try {
    // Without the KV the once-per-cycle marker cannot be kept and the hourly sweep would alert every hour: stay quiet.
    if (!env || !env.OWNER_ALERT_EMAIL || !env.RATE_LIMIT_KV) return out
    const closed = recentCycles(2)[1]
    const key = `partner-payout-due:${closed.key}`
    const checkedKey = `partner-payout-due-checked:${closed.key}`
    if (await referralService.keySeen(env, checkedKey)) return out
    // Round 23: the value stored with the sent-marker is what the first alert reported, so a later sweep can tell when MORE
    // became ready (a hold expired, a partner added payout details) and send one follow-up instead of staying silent.
    const sentRaw = await referralService.keyGet(env, key)
    let prev = null
    if (sentRaw) {
      try { prev = JSON.parse(sentRaw) } catch (_) { prev = null }
      if (!prev || typeof prev.readyCents !== 'number') return out     // marker from before follow-ups: nothing more to do
    }

    const partners = await loadAllPartners(supabase, t => t.select('id, email, payout_method, payout_details_submitted_at, terms_version'))
    const live = (partners || []).filter(p => !isRemovedEmail(p.email))
    const ledgerByPartner = await loadUnpaidLedgerByPartner(supabase)
    const holdDays = holdDaysFor(env), minPayout = minPayoutFor(env)
    let ready = 0, readyCents = 0, noDetails = 0, noDetailsCents = 0, heldCents = 0, waiting = 0, waitingCents = 0
    const cur0 = c.activeCurrency(env)
    const holdHours = payoutDetailsHoldHoursFor(env), termsGate = payoutRequiresCurrentTerms(env)
    for (const p of live) {
      const ledger = ledgerByPartner.get(p.id) || []
      const r = payoutReadiness(ledger, holdDays, minPayout)
      heldCents += Math.max(0, heldCentsOf(ledger, holdDays))
      if (r.readyToPayCents <= 0) continue
      // A payout can only settle one currency: the payout-run export leaves such a partner out, so the alert does too.
      if (new Set(ledger.map(l => String(l.currency || cur0).toUpperCase())).size > 1) continue
      if (!p.payout_method) { noDetails++; noDetailsCents += r.readyToPayCents; continue }
      // Round 41 (bug): a partner whose payout details changed inside the hold window, or who is behind on the terms while
      // PAYOUT_REQUIRES_CURRENT_TERMS is on, was counted "ready to pay"; Run payouts then refused them until the admin confirmed.
      // They are counted apart now, and join "ready" (a follow-up alert) once the hold ends or the terms are accepted.
      if (payoutHoldUntilOf(p.payout_details_submitted_at, holdHours) || (termsGate && p.terms_version !== PARTNER_TERMS_VERSION)) {
        waiting++; waitingCents += r.readyToPayCents; continue
      }
      ready++; readyCents += r.readyToPayCents
    }
    out.ready = ready; out.readyCents = readyCents; out.waiting = waiting; out.waitingCents = waitingCents
    const cur = c.activeCurrency(env)
    if (prev) {
      if (readyCents > prev.readyCents) {
        const more = await emailService.sendOwnerAlert(env, `More partner payouts are now ready (${closed.label})`,
          `Since the last alert for cycle ${closed.label}, more commission became payable (a hold expired or a partner added payout details).\n` +
          `ready to pay now: ${ready} partner(s), ${(readyCents / 100).toFixed(2)} ${cur} (was ${(prev.readyCents / 100).toFixed(2)} ${cur} at the last check)\n` +
          (noDetails ? `ready but no payout details yet: ${noDetails} partner(s), ${(noDetailsCents / 100).toFixed(2)} ${cur}\n` : '') +
          (waiting ? `payable but waiting (payout details changed recently, or the current terms are not accepted): ${waiting} partner(s), ${(waitingCents / 100).toFixed(2)} ${cur}\n` : '') +
          `Open Admin -> Partners -> Run payouts.`, { dedupeKey: `${closed.key}:more:${readyCents}` })
        if (more !== false) {
          out.sent = true
          await referralService.keyMark(env, key, 20 * 24 * 3600, JSON.stringify({ ready, readyCents }))
        } else return out
      }
      else if (readyCents < prev.readyCents) {
        // Payouts were recorded since the last alert: lower the baseline so commission that becomes payable AFTER that is
        // compared against what is actually still ready, not against the first alert's larger figure.
        await referralService.keyMark(env, key, 20 * 24 * 3600, JSON.stringify({ ready, readyCents }))
      }
      await referralService.keyMark(env, checkedKey, 6 * 3600)
    } else if (ready > 0 || noDetails > 0) {
      const alertResult = await emailService.sendOwnerAlert(env, `Partner payouts are ready to run (${closed.label})`,
        `Cycle ${closed.label} has closed.\n` +
        `ready to pay: ${ready} partner(s), ${(readyCents / 100).toFixed(2)} ${cur}\n` +
        (noDetails ? `ready but no payout details yet: ${noDetails} partner(s), ${(noDetailsCents / 100).toFixed(2)} ${cur}\n` : '') +
        (waiting ? `payable but waiting (payout details changed recently, or the current terms are not accepted): ${waiting} partner(s), ${(waitingCents / 100).toFixed(2)} ${cur}\n` : '') +
        (heldCents ? `still held (hold window / open dispute): ${(heldCents / 100).toFixed(2)} ${cur}\n` : '') +
        `Open Admin -> Partners -> Run payouts.`, { dedupeKey: closed.key })
      out.sent = alertResult !== false
      if (!out.sent) return out            // not marked: the next hourly sweep tries again
      await referralService.keyMark(env, key, 20 * 24 * 3600, JSON.stringify({ ready, readyCents }))
      await referralService.keyMark(env, checkedKey, 6 * 3600)
    } else {
      await referralService.keyMark(env, checkedKey, 6 * 3600)
    }
  } catch (err) { console.error('sweepPayoutDue:', err.message) }
  return out
}

// Partners round 41 (feature gap): a partner whose commission is payable but who never added payout details used to hear NOTHING:
// the owner was alerted (sweepPayoutDue) and the dashboard shows a banner, but a partner who does not open the dashboard simply never
// got paid. Once per closed cycle each such ACTIVE partner now gets one email pointing at the dashboard, whose "Email me a link to add
// them" button issues the payout link. Independent of OWNER_ALERT_EMAIL; needs the KV so it can never repeat hourly. Never throws.
const DETAILS_REMINDER_MAX_PER_RUN = 20
async function sweepPayoutDetailsReminders(env, supabase) {
  const out = { sent: 0, skipped: 0 }
  try {
    if (!env || !env.RATE_LIMIT_KV || !env.FRONTEND_URL) return out
    const closed = recentCycles(2)[1]
    // The pass reads every partner and the whole unpaid ledger, so a finished pass is remembered for 6 hours (like sweepPayoutDue's).
    const checkedKey = `partner-details-reminder-checked:${closed.key}`
    if (await referralService.keySeen(env, checkedKey)) return out
    const partners = await loadAllPartners(supabase, t => t.select('id, name, email, status, payout_method, dashboard_token, dashboard_token_version').eq('status', 'ACTIVE').is('payout_method', null))
    const candidates = (partners || []).filter(p => p.email && !isRemovedEmail(p.email) && p.status === 'ACTIVE' && !p.payout_method)
    if (!candidates.length) return out
    const ledgerByPartner = await loadUnpaidLedgerByPartner(supabase)
    const holdDays = holdDaysFor(env), minPayout = minPayoutFor(env), cur = c.activeCurrency(env)
    let attempts = 0
    for (const p of candidates) {
      if (attempts >= DETAILS_REMINDER_MAX_PER_RUN) break
      const ledger = ledgerByPartner.get(p.id) || []
      const r = payoutReadiness(ledger, holdDays, minPayout)
      if (r.readyToPayCents <= 0) continue
      if (new Set(ledger.map(l => String(l.currency || cur).toUpperCase())).size > 1) continue   // one payout settles one currency
      const sentKey = `partner-details-reminder:${p.id}:${closed.key}`
      const tryKey = `partner-details-reminder-try:${p.id}:${closed.key}`
      if (await referralService.keySeen(env, sentKey) || await referralService.keySeen(env, tryKey)) { out.skipped++; continue }
      attempts++
      const ok = await emailService.sendPartnerPayoutDetailsReminder(env, supabase, p.email, p.name, r.readyToPayCents, cur, await partnerLinks.dashboardUrlOf(env, p)).catch(() => false)
      if (ok !== false) { out.sent++; await referralService.keyMark(env, sentKey, 20 * 24 * 3600) }
      else await referralService.keyMark(env, tryKey, 12 * 3600)   // suppressed / throttled / provider down: not hourly, retried later in the cycle
    }
    if (attempts < DETAILS_REMINDER_MAX_PER_RUN) await referralService.keyMark(env, checkedKey, 6 * 3600)   // cap reached: the next run continues
  } catch (err) { console.error('sweepPayoutDetailsReminders:', err.message) }
  return out
}

// Round 23: the full payout details of every partner who is payable right now, for the payout-run CSV. It is the only
// bulk read of full account numbers / tax IDs, so the route puts it behind the admin step-up.
async function adminPayoutRunExport(ctx) {
  const supabase = getSupabase(ctx.env)
  if (!(await auditBeforeReveal(ctx, supabase, 'partner.payout_run_exported', 'partner', null, {}))) return auditUnavailable(ctx)
  const data = await loadAllPartners(supabase, t => t.select('*').not('payout_method', 'is', null))
  const ledgerByPartner = await loadUnpaidLedgerByPartner(supabase)
  const holdDays = holdDaysFor(ctx.env), minPayout = minPayoutFor(ctx.env), currency = c.activeCurrency(ctx.env)
  const rows = []
  for (const row of data || []) {
    if (isRemovedEmail(row.email)) continue
    const ledger = ledgerByPartner.get(row.id) || []
    const r = payoutReadiness(ledger, holdDays, minPayout)
    if (r.readyToPayCents <= 0) continue
    if (new Set(ledger.map(l => String(l.currency || currency).toUpperCase())).size > 1) continue
    rows.push({ id: row.id, name: row.name, email: row.email, payoutMethod: row.payout_method, payoutDetails: row.payout_details || {},
      payoutDetailsSubmittedAt: row.payout_details_submitted_at,
      // Round 41: the server states what Run payouts would refuse without an admin confirmation, so no consumer has to recompute it.
      detailsHoldUntil: payoutHoldUntilOf(row.payout_details_submitted_at, payoutDetailsHoldHoursFor(ctx.env)),
      termsCurrent: row.terms_version === PARTNER_TERMS_VERSION,
      taxCountry: row.tax_country ?? null, taxId: (await fieldCrypto.openTaxId(ctx.env, row.tax_id)) || null,
      readyToPayCents: r.readyToPayCents, currency })
  }
  ctx.header('Cache-Control', 'no-store')
  return ctx.json({ success: true, data: rows })
}

async function adminListPartners(ctx) {
  const supabase = getSupabase(ctx.env)
  // SECTION 4 ROUND 4 (scale): this used to embed EVERY partner's full payout history,
  // code list and complete commission ledger into one query on every page load — cost
  // grew with total platform history. The list view only needs the UNPAID ledger rows
  // (pending / ready / held / current-cycle figures), so that is all it reads now, paged
  // so PostgREST's row cap can't silently truncate it. Payout history, codes and
  // per-code stats live behind adminGetPartner. (netConversions moved there too: it needs
  // paid rows, and no list column shows it.)
  const data = await loadAllPartners(supabase, t => t.select('*'))

  const ledgerByPartner = await loadUnpaidLedgerByPartner(supabase)

  const holdDays = holdDaysFor(ctx.env)
  const awaitingSetup = data.filter(r => !r.payout_method && r.email && !isRemovedEmail(r.email)).map(r => r.email)
  const linkMail = awaitingSetup.length ? await latestPayoutLinkEmailStatus(supabase, awaitingSetup) : new Map()
  // Tax IDs are stored sealed; the list shows only their last four characters, so open them once here (cheap, and only rows that have one).
  const taxMask = new Map(await Promise.all(data.filter(r => r.tax_id).map(async r => [r.id, last4Of(await fieldCrypto.openTaxId(ctx.env, r.tax_id)) || null])))
  const partners = data.map(row => {
    const camel = partnerRowToCamel(row)
    const ledger = ledgerByPartner.get(row.id) || []
    // 'sent' | 'failed' | 'throttled' | 'suppressed' | null (never mailed / lookup failed). Only for partners
    // who still have no payout details on file.
    // Round 23: the list never carries the full account number or tax ID (the payout-run export fetches them
    // behind a step-up from /partners/payout-export).
    camel.payoutDetails = maskedPayoutDetailsForOwner(row.payout_method, row.payout_details)
    camel.taxId = taxMask.get(row.id) || null
    camel.detailsMasked = true
    camel.payoutLinkEmail = !row.payout_method ? (linkMail.get(String(row.email || '').toLowerCase()) || null) : null
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
    camel.currency                 = c.activeCurrency(ctx.env)
    // Round 8: the totals above add raw cents, which is only meaningful in one currency. adminGetPartner always
    // flagged mixed-currency ledgers; the list (and the payout run built from it) did not.
    camel.mixedCurrency            = new Set(ledger.map(l => String(l.currency || camel.currency).toUpperCase())).size > 1
    camel.termsCurrent             = row.terms_version === PARTNER_TERMS_VERSION
    camel.termsNoticePending       = row.terms_version !== PARTNER_TERMS_VERSION && row.terms_notified_version !== PARTNER_TERMS_VERSION
    camel.legacyDashboardLink      = !!row.dashboard_token && !isRemovedEmail(row.email)   // round 33: still on a stored link (admin "Convert")
    return camel
  })
  // Round 6: the payout-details hold the server enforces, so the "Record payout run" screen flags the same partners.
  return ctx.json({ success: true, payoutDetailsHoldHours: payoutDetailsHoldHoursFor(ctx.env), currentTermsVersion: PARTNER_TERMS_VERSION, termsBlockPayout: payoutRequiresCurrentTerms(ctx.env), data: partners })
}

// ── Admin: single partner detail — full ledger, full payout history, and a
// deeper (12-cycle, ~6 month) rolling cycle breakdown for the drill-down page.

async function adminGetPartner(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase
    .from('partners')
    .select(`
      *,
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, internal_note, settled_commission_cents, period_start, period_end, paid_at, created_at, payout_details_snapshot, voided_at, void_reason),
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at)
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
    .maybeSingle()
  if (error) throw error
  if (!row) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const ledger = await loadLedgerForPartner(supabase, partnerId,
    'id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, currency, payout_id, reverses_ledger_id, adjusts_ledger_id, reversal_reason, kind, adjustment_reason, usage_counted, attribution_source, attribution_sub, created_at, payments(status, paystack_ref)')
  row.commission_ledger = ledger
  const camel = partnerRowToCamel(row)
  // Round 27 (gap): this view used to hand any admin session the FULL account number and tax ID (and every payout's full
  // snapshot), which made the step-up on the payout export and the audit trail around it pointless - read the detail page
  // instead. It now carries the same masked form as the list; the full values come from GET /:id/payout-details, which is
  // step-up gated and logged (partner.details_viewed).
  camel.payoutDetails = maskedPayoutDetailsForOwner(row.payout_method, row.payout_details)
  camel.taxId = row.tax_id ? (last4Of(await fieldCrypto.openTaxId(ctx.env, row.tax_id)) || null) : null
  camel.detailsMasked = true
  camel.payouts = (camel.payouts || []).map(po => ({ ...po,
    payoutDetailsSnapshot: maskedPayoutDetailsForOwner(po.payoutMethod, po.payoutDetailsSnapshot) || {} }))
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
  camel.referralCodes = await attachSignupCounts(supabase, attachCodeStats(camel.referralCodes, ledger, row.referral_codes))
  // AUDIT FIX (Section 3/4 pass, bug): see the matching fix in
  // adminListPartners above — same currency-drift gap, same fix.
  camel.currency = c.activeCurrency(ctx.env)
  // Round 6: surfaced for the admin screen — the hold window the server enforces on payouts after a payout-details
  // change, and whether unpaid commission spans more than one currency (a payout can only settle one).
  camel.payoutDetailsHoldHours = payoutDetailsHoldHoursFor(ctx.env)
  camel.unpaidCurrencies = [...new Set(ledger.filter(l => !l.payout_id).map(l => String(l.currency || camel.currency).toUpperCase()))]
  camel.mixedCurrency = camel.unpaidCurrencies.length > 1
  // Round 42: what an ad hoc payout in each currency would settle (unpaid, minus the refund-window hold), so the payout form can default it.
  camel.unpaidByCurrency = Object.fromEntries(camel.unpaidCurrencies.map(cur => {
    const rows = ledger.filter(l => String(l.currency || camel.currency).toUpperCase() === cur)
    return [cur, pendingCents(rows) - heldCentsOf(rows, holdDays)]
  }))
  camel.currentTermsVersion = PARTNER_TERMS_VERSION
  camel.termsCurrent = row.terms_version === PARTNER_TERMS_VERSION
  camel.termsNoticePending = row.terms_version !== PARTNER_TERMS_VERSION && row.terms_notified_version !== PARTNER_TERMS_VERSION

  return ctx.json({ success: true, data: camel })
}

// ── Admin: re-send a partner's payout-details link (same token) ────────────

async function adminResendPayoutLink(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const supabase = getSupabase(ctx.env)
  // Section 4 round 13 (feature gap): `scope` 'dashboard' re-sends the read-only dashboard link (the one every conversion
  // email carries); admins could only ever re-send the payout-details link. Default stays 'payout'.
  const resendBody = typeof ctx.req.json === 'function' ? await ctx.req.json().catch(() => null) : null
  const resendScope = resendBody && resendBody.scope === 'dashboard' ? 'dashboard' : 'payout'
  const { data: partner, error } = await supabase
    .from('partners').select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  if (isRemovedEmail(partner.email)) return partnerRemovedResponse(ctx)

  if (resendScope === 'dashboard') {
    const dashboardUrl = await partnerLinks.dashboardUrlOf(ctx.env, partner)
    const sentDash = await emailService.sendPartnerLinksRecovery(ctx.env, supabase, partner.email, partner.name, dashboardUrl, { quotaKey: 'partner_links_recovery:admin' })
    await logAdminAction(ctx, supabase, 'partner.dashboard_link_resent', 'partner', partnerId, { emailed: sentDash })
    return ctx.json({ success: sentDash,
      message: sentDash ? 'Dashboard link re-sent.' : 'Email not sent — it failed or hit this partner\'s hourly email limit. Check logs, or copy the link instead.',
      ...(sentDash ? {} : { dashboardUrl }) })
  }

  const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${await issuePayoutToken(supabase, partnerId)}`
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
  // Round 22: the stored token is a hash, so minting this link already replaced the one the partner was emailed earlier. When the
  // email did not go, that is the one thing the admin must know: their previous link is dead and the copied one is the only way in.
  // (Restoring the old hash instead would make the link handed back here dead, which defeats the fallback.)
  return ctx.json({ success: sent,
    message: sent ? 'Link re-sent.' : 'Email not sent — it failed or hit this partner\'s 4-per-hour limit. Their previous payout link no longer works, so send them the new link yourself (or Resend again later).',
    ...(sent ? {} : { payoutUrl, previousLinkRevoked: true }) })
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
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  // The body is optional (the pre-round-5 caller sent none) — absent or unparsable means 'payout'.
  let raw = {}
  try { raw = await ctx.req.json() } catch (_) { raw = {} }
  const { scope = 'payout' } = regenerateLinkSchema.parse(raw || {})
  const supabase = getSupabase(ctx.env)
  const rotatePayout = scope === 'payout' || scope === 'both'
  const rotateDash   = scope === 'dashboard' || scope === 'both'
  const newPayoutToken = rotatePayout ? cryptoLib.randomToken(32) : null

  const { data: current, error: curErr } = await supabase.from('partners').select('email, dashboard_token_version').eq('id', partnerId).maybeSingle()
  if (curErr) throw curErr
  if (current && isRemovedEmail(current.email)) return partnerRemovedResponse(ctx)

  const { data: partner, error } = await supabase
    .from('partners')
    .update({ ...(rotatePayout ? await payoutTokenFields(newPayoutToken) : {}), ...(rotateDash ? partnerLinks.rotateDashboardPatch(current || {}) : {}), updated_at: new Date().toISOString() })
    .eq('id', partnerId)
    .select('id, name, email, dashboard_token, dashboard_token_version')
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)

  const payoutUrl    = rotatePayout ? `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${newPayoutToken}` : null
  const dashboardUrl = rotateDash ? await partnerLinks.dashboardUrlOf(ctx.env, partner) : null
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
// dashboard shows" meant guessing. Returns the dashboard link; admin-only and audit-logged
// because it is a bearer credential. (Round 22: read-only — the payout link comes from the POST routes.)
async function adminGetPartnerLinks(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners').select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  if (isRemovedEmail(partner.email)) return partnerRemovedResponse(ctx)
  ctx.header('Cache-Control', 'no-store')
  // Round 22: this is a GET, so it only READS. It used to mint a new payout token on every call (the payout token is stored hashed,
  // so "showing" it meant replacing it), which made a repeated or retried request kill the link the partner held. The payout link
  // is now issued only by the explicit POST routes (regenerate-link / resend-link). `?scope` is accepted and ignored.
  await logAdminAction(ctx, supabase, 'partner.links_viewed', 'partner', partnerId, { payoutRotated: false })
  return ctx.json({ success: true, data: {
    dashboardUrl: await partnerLinks.dashboardUrlOf(ctx.env, partner)
  } })
}

// Section 4 round 25 (bug): no upper bound here, so a typo like 3,000,000,000 sailed past validation and hit the
// referral_tier_prices_valid CHECK (migration 0100: payments.amount_cents is a 4-byte int) as a raw database error
// instead of a clean 400. One bound on the shared schema covers create, update and approve-with-first-code.
const MAX_TIER_PRICE_CENTS = 2147483647
const tierPrice = z.number().int().positive().max(MAX_TIER_PRICE_CENTS, 'That price is larger than the allowed maximum.')
const tierPricesSchema = z.object({
  FIX:       tierPrice.optional(),
  BADGE:     tierPrice.optional(),
  FIX_PLAIN: tierPrice.optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one tier price is required.')

// Round 10 (feature gap): tier_prices were free-typed cents with no sense of the product's price. $49.00 typed as
// 49 (cents) gave buyers a $0.49 resume fix, and a price at or above the standard price gave a "discount" code that
// discounts nothing. A price under REFERRAL_MIN_PRICE_PCT (default 10) % of the standard price is refused unless the
// admin passes confirmLowPrice; a price that is not below standard comes back as a warning. Judged against the
// platform currency's STANDARD table (never the promo) so it is stable while a promo runs.
function referralMinPricePct(env) {
  // Strict (lib/numEnv): Number('') is 0, which silently switched the guard OFF for a blank variable; "0x10" read as 16.
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')
  return numEnv(env && env.REFERRAL_MIN_PRICE_PCT, 10, NUMERIC_ENV.REFERRAL_MIN_PRICE_PCT)
}
function priceGuardrails(env, tierPrices) {
  const out = { tooLow: [], noDiscount: [] }
  const pct = referralMinPricePct(env)
  for (const [tier, price] of Object.entries(tierPrices || {})) {
    let standard
    try { standard = c.standardPriceForTier(tier, env) } catch (_) { return { tooLow: [], noDiscount: [] } }   // no table: cannot judge
    if (price >= standard) out.noDiscount.push({ tier, price, standard })
    else if (pct > 0 && price < Math.floor(standard * pct / 100)) out.tooLow.push({ tier, price, standard, floor: Math.floor(standard * pct / 100) })
  }
  return out
}
function lowPriceResponse(ctx, guard) {
  return ctx.json({ success: false, code: 'PRICE_TOO_LOW', details: guard.tooLow,
    message: `Tier price(s) far below the standard price (${guard.tooLow.map(t => `${t.tier}: ${t.price} vs standard ${t.standard}`).join('; ')}). Prices are in the smallest currency unit (cents) — check for a missing zeros. Resend with confirmLowPrice to proceed.` }, 400)
}
function guardWarnings(guard) {
  return guard.noDiscount.map(t => `${t.tier} price (${t.price}) is not below the standard price (${t.standard}), so this tier gives buyers no discount.`)
}

const createReferralCodeSchema = z.object({
  // Codes travel in URLs (?ref=CODE), so restrict to characters that survive
  // a link untouched.
  code:       z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, numbers, hyphens and underscores.'),
  tierPrices: tierPricesSchema,
  usageLimit: z.number().int().positive().optional(),
  expiresAt:  z.string().datetime().optional().refine(v => !v || Date.parse(v) > Date.now(), 'Expiry must be in the future.'),
  confirmLowPrice: z.boolean().optional()
})

async function adminCreateReferralCode(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const body = createReferralCodeSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data: partner, error: pErr } = await supabase
    .from('partners').select(`name, email, status, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  if (isRemovedEmail(partner.email)) return partnerRemovedResponse(ctx)
  // Partners round 40: an ENDED partnership earns and discounts nothing, so a fresh code would be dead on arrival. A PAUSED
  // partner may still be given one (it waits for reactivation, and the response says so).
  if (partner.status === 'ENDED')
    return ctx.json({ success: false, message: 'This partnership has ended - reactivate the partner before creating a code for them.' }, 409)

  const guard = priceGuardrails(ctx.env, body.tierPrices)
  if (guard.tooLow.length && !body.confirmLowPrice) return lowPriceResponse(ctx, guard)

  const { data: codeRow, error } = await supabase.from('referral_codes').insert({
    partner_id:  partnerId,
    code:        body.code.trim().toUpperCase(),
    tier_prices: body.tierPrices,
    usage_limit: body.usageLimit || null,
    expires_at:  body.expiresAt || null
  }).select('*').single()
  // Round 8: a taken code surfaced as the generic 409 "Already exists." (errorHandler); say what is wrong.
  if (error && error.code === '23505')
    return ctx.json({ success: false, message: 'That code is already in use - pick a different one.' }, 409)
  if (error) throw error

  // A PAUSED partner's codes don't apply discounts or earn commission (see
  // isCodeUsable), so telling them "your code is ready" would be wrong — the
  // code is created and waits for reactivation; the admin is told as much.
  const partnerPaused = partner.status !== 'ACTIVE'
  // Round 29: `notified` used to be `!partnerPaused` even when the send failed or was throttled (the error was swallowed).
  let notified = false
  if (!partnerPaused) {
    const dashboardUrl = await partnerLinks.dashboardUrlOf(ctx.env, partner)
    notified = await emailService.sendReferralCodeCreated(ctx.env, supabase, partner.email, partner.name, codeRow.code, dashboardUrl)
      .then(ok => ok === true || ok === undefined).catch(() => false)
  }

  // Partners round 39: a code now exists for this partner, so a waiting "I'd like a code" request is answered. Best effort - the list's
  // own Done / Dismiss buttons remain, and a database without migration 0116 simply has none.
  await supabase.from('partner_code_requests').update({ status: 'DONE', resolved_at: new Date().toISOString() })
    .eq('partner_id', partnerId).eq('status', 'OPEN').then(r => { if (r && r.error) console.error('code request auto-resolve:', r.error.message) }, err => console.error('code request auto-resolve:', err.message))

  await logAdminAction(ctx, supabase, 'partner.referral_code_created', 'referral_code', codeRow.id, {
    partnerId, codeId: codeRow.id, tierPrices: codeRow.tier_prices, usageLimit: codeRow.usage_limit, expiresAt: codeRow.expires_at,
    lowPriceConfirmed: guard.tooLow.length > 0
  })

  return ctx.json({ success: true, data: referralCodeRowToCamel(codeRow), notified, partnerPaused, warnings: guardWarnings(guard) })
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
  code:        z.string().trim().min(2).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Code may only contain letters, numbers, hyphens and underscores.').optional(),
  active:      z.boolean().optional(),
  tierPrices:  tierPricesSchema.optional(),
  usageLimit:  z.number().int().positive().nullable().optional(),
  expiresAt:   z.string().datetime().nullable().optional()
    .refine(v => !v || Date.parse(v) > Date.now(), 'Expiry must be in the future.'),
  confirmLowPrice: z.boolean().optional()
}).refine(obj => Object.keys(obj).filter(k => k !== 'confirmLowPrice').length > 0, 'At least one field is required.')

// What actually differs between the code before and after an edit, as small structured facts for the partner's email.
function describeCodeChanges(before, after) {
  if (!before || !after) return []
  const out = []
  if (before.code && after.code && before.code !== after.code) out.push({ field: 'code', from: before.code, to: after.code })
  if (!!before.active !== !!after.active) out.push({ field: 'active', to: !!after.active })
  if (JSON.stringify(before.tier_prices || {}) !== JSON.stringify(after.tier_prices || {})) out.push({ field: 'tierPrices', to: after.tier_prices || {} })
  if ((before.usage_limit ?? null) !== (after.usage_limit ?? null)) out.push({ field: 'usageLimit', to: after.usage_limit ?? null })
  if (!sameInstant(before.expires_at ?? null, after.expires_at ?? null)) out.push({ field: 'expiresAt', to: after.expires_at ?? null })
  return out
}

async function adminUpdateReferralCode(ctx) {
  const codeId = ctx.req.param('codeId')
  const body = updateReferralCodeSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const patch = {}
  if (body.active !== undefined)      patch.active = body.active
  if (body.tierPrices !== undefined)  patch.tier_prices = body.tierPrices
  if (body.usageLimit !== undefined)  patch.usage_limit = body.usageLimit
  if (body.expiresAt !== undefined)   patch.expires_at = body.expiresAt
  const newCode = body.code ? body.code.toUpperCase() : undefined

  const guard = body.tierPrices !== undefined ? priceGuardrails(ctx.env, body.tierPrices) : { tooLow: [], noDiscount: [] }
  if (guard.tooLow.length && !body.confirmLowPrice) return lowPriceResponse(ctx, guard)

  // Re-activating (or re-pricing) a code that belongs to an anonymized partner would put discounts and commission
  // back on a record that was erased; switching one OFF stays allowed.
  // Round 20: the same read now also keeps the code as it is BEFORE the edit, so the partner can be told what changed.
  const { data: owner, error: ownerErr } = await supabase.from('referral_codes')
    .select('partner_id, code, active, tier_prices, usage_limit, expires_at, partners(name, email, status)').eq('id', codeId).maybeSingle()
  if (ownerErr) throw ownerErr
  if (owner && isSystemPartnerId(owner.partner_id)) return systemPartnerResponse(ctx)
  if (body.active !== false && owner && isRemovedEmail(owner.partners?.email)) return partnerRemovedResponse(ctx)
  if (!owner && newCode) return ctx.json({ success: false, message: 'Referral code not found.' }, 404)

  // Round 23: a code's text can be corrected. The old text stops working everywhere, so the buyers and payments that
  // carry it are moved to the new text in the same call (and the rename is undone if that cannot be done).
  const renaming = !!newCode && !!owner && newCode !== owner.code
  if (renaming && (isRemovedEmail(owner.partners?.email) || /^REMOVED-[0-9A-F]{8}$/.test(owner.code)))
    return ctx.json({ success: false, message: 'A removed partner\u2019s code cannot be renamed.' }, 409)
  if (!Object.keys(patch).length && !renaming) return ctx.json({ success: false, message: 'Nothing to change.' }, 400)

  // Partners round 40: the rename is ONE transaction in the database (migration 0117) rather than three writes with a hand-rolled
  // undo. A database that has not run 0117 yet falls back to the old sequence so a deploy order slip cannot break renames.
  let legacyRename = false
  if (renaming) {
    const { error: rnErr } = await supabase.rpc('rename_referral_code', { p_code_id: codeId, p_new_code: newCode })
    if (rnErr && rnErr.code === '23505') return ctx.json({ success: false, message: 'That code is already in use - pick a different one.' }, 409)
    if (rnErr && rnErr.code === 'P0002') return ctx.json({ success: false, message: 'Referral code not found.' }, 404)
    if (rnErr && (rnErr.code === 'PGRST202' || rnErr.code === '42883')) { legacyRename = true; patch.code = newCode }
    else if (rnErr) throw rnErr
  }

  let data = null
  if (Object.keys(patch).length) {
    const { data: upd, error } = await supabase.from('referral_codes')
      .update(patch).eq('id', codeId).select('*').maybeSingle()
    if (error && error.code === '23505') return ctx.json({ success: false, message: 'That code is already in use - pick a different one.' }, 409)
    if (error) throw error
    data = upd
  } else {
    const { data: cur, error } = await supabase.from('referral_codes').select('*').eq('id', codeId).maybeSingle()
    if (error) throw error
    data = cur
  }
  if (!data) return ctx.json({ success: false, message: 'Referral code not found.' }, 404)

  if (renaming && legacyRename) {
    const undo = async () => { await supabase.from('referral_codes').update({ code: owner.code }).eq('id', codeId).then(() => {}, () => {}) }
    const { error: uErr } = await supabase.from('users').update({ referred_by_code: newCode }).eq('referred_by_code', owner.code)
    if (uErr) { await undo(); throw uErr }
    const { error: pErr } = await supabase.from('payments').update({ referral_code: newCode }).eq('referral_code_id', codeId)
    if (pErr) {
      await supabase.from('users').update({ referred_by_code: owner.code }).eq('referred_by_code', newCode).then(() => {}, () => {})
      await undo(); throw pErr
    }
  }

  await logAdminAction(ctx, supabase, 'partner.referral_code_updated', 'referral_code', codeId, {
    partnerId: data.partner_id, codeId: data.id, changed: [...new Set([...Object.keys(patch), ...(renaming ? ['code'] : [])])], lowPriceConfirmed: guard.tooLow.length > 0,
    ...(renaming ? { renamedFrom: owner.code, renamedTo: newCode } : {})
  })

  // Round 20 (feature gap): a partner was told about every other change to their account (status, rate, email, balance, a voided
  // payout) but never that their code was switched off, re-priced, capped or given a new expiry — they learned it from a buyer.
  // Only REAL changes are reported (an edit that re-saves the same value says nothing), only to a live, mail-able partner, and
  // only when it affects what buyers get; best-effort like every notification here.
  let notified = false
  try {
    const changes = describeCodeChanges(owner, data)
    const p = owner?.partners
    if (changes.length && p?.email && !isRemovedEmail(p.email) && p.status === 'ACTIVE') {
      notified = (await emailService.sendPartnerCodeChanged(ctx.env, supabase, p.email, p.name, data.code, changes, c.activeCurrency(ctx.env))) === true
    }
  } catch (err) { console.error('adminUpdateReferralCode partner notice:', err.message) }

  const limitWarning = body.usageLimit != null && data.usage_limit != null && (data.uses_so_far || 0) >= data.usage_limit
    ? [`This limit (${data.usage_limit}) is at or below the ${data.uses_so_far || 0} redemption(s) already used, so the code stops applying immediately.`] : []
  // Partners round 40: switching a code on (or editing it) for a PAUSED / ENDED partner reports success, yet isCodeUsable still refuses it.
  const partnerStatus = owner?.partners?.status
  const partnerInactive = !!partnerStatus && partnerStatus !== 'ACTIVE' && data.active !== false
  const inactiveWarning = partnerInactive
    ? [`This partner is ${partnerStatus === 'ENDED' ? 'ended' : 'paused'}, so the code will not apply discounts or earn commission until the partner is made Active again.`] : []
  return ctx.json({ success: true, partnerInactive, data: referralCodeRowToCamel(data), warnings: [...guardWarnings(guard), ...limitWarning, ...inactiveWarning, ...(renaming ? [`Renamed ${owner.code} to ${newCode}. Links and codes already shared with the old text no longer work.`] : [])], notified, ...(renaming ? { renamed: { from: owner.code, to: newCode } } : {}) })
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
// Partners round 38: the settlement RPC stores amount_cents as int4; anything larger overflowed there AFTER the partner row was locked and came
// back as a bare 500. Refused at the boundary instead.
const MAX_PAYOUT_CENTS = 2147483647
const recordPayoutSchema = z.object({
  amountCents:  z.number().int().positive().max(MAX_PAYOUT_CENTS, 'That amount is larger than the allowed maximum.').optional(),
  confirmedTerms: z.boolean().optional(),
  currency:     z.string().trim().regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter code.').transform(v => v.toUpperCase()).optional(),
  // Partners round 42 (gap): a partner whose unpaid commission spans currencies (the platform currency was changed) could never be paid -
  // every payout refused with CURRENCY_MISMATCH and nothing could select one currency. With this flag the payout settles ONLY the unpaid
  // rows in `currency` and leaves the others owed for their own payout.
  onlyCurrency: z.boolean().optional(),
  payoutMethod: z.enum(['BANK', 'MOBILE_MONEY', 'PAYPAL']).optional(),
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
// Round 10: `.in('id', [...])` puts every id in the request URL. A partner with a few hundred unpaid rows (a long
// stretch of 'ready' payouts, or an ad hoc payout of everything) overflowed the URL limit and the payout failed with a
// 500 AFTER the money had gone out. Every id list that reaches PostgREST is chunked.
const IN_CHUNK = 100
function chunked(list, size = IN_CHUNK) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}
async function selectInChunks(makeQuery, ids) {
  const rows = []
  for (const part of chunked(ids)) {
    const { data, error } = await makeQuery(part)
    if (error) return { data: rows, error }
    rows.push(...(data || []))
  }
  return { data: rows, error: null }
}

async function recordPayoutCore(ctx, supabase, partnerId, body, reply, opts = {}) {
  if (isSystemPartnerId(partnerId))
    return reply({ success: false, code: 'SYSTEM_PARTNER', message: 'This is the internal welcome-code record; it is never paid.' }, 409)

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
  // Partners round 38 (feature gap): the terms prompt on the dashboard was the ONLY consequence of not accepting a new version. With
  // PAYOUT_REQUIRES_CURRENT_TERMS=1 a payout to a partner on an older version is refused until the admin ticks that they will be paid anyway.
  if (payoutRequiresCurrentTerms(ctx.env) && partner.terms_version !== PARTNER_TERMS_VERSION && !body.confirmedTerms)
    return reply({
      success: false,
      code: 'TERMS_NOT_ACCEPTED',
      message: `This partner has not accepted the current partner terms (${PARTNER_TERMS_VERSION}). Ask them to accept on their dashboard, or confirm you are paying them anyway.`
    }, 409)
  if (body.payoutMethod && body.payoutMethod !== payoutMethod)
    return reply({ success: false,
      message: `This partner's payout details are for ${payoutRails.methodLabelLower(payoutMethod)}, not ${payoutRails.methodLabelLower(body.payoutMethod)}.` }, 400)

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

  let ledgerQuery = supabase.from('commission_ledger').select('id, commission_amount_cents, reverses_ledger_id, kind, currency, created_at, payments(status)')
    .eq('partner_id', partnerId).is('payout_id', null)
  // Round 15 (bug): `lte(periodEnd)` with periodEnd = 23:59:59.999 left out a row stamped inside the last millisecond (timestamptz
  // keeps microseconds) although cycleKey() files it in this cycle. An exclusive bound one millisecond later is exact.
  if (body.periodStart) ledgerQuery = ledgerQuery.gte('created_at', body.periodStart).lt('created_at', new Date(Date.parse(body.periodEnd) + 1).toISOString())
  else if (opts.scope === 'ready') ledgerQuery = ledgerQuery.lt('created_at', recentCycles(1)[0].start)
  // Refund-window hold (COMMISSION_HOLD_DAYS): young commission rows stay
  // unpaid; reversal rows always settle.
  const holdDays = holdDaysFor(ctx.env)
  if (holdDays) {
    const cutoff = new Date(Date.now() - holdDays * 86400000).toISOString()
    ledgerQuery = ledgerQuery.or(`reverses_ledger_id.not.is.null,kind.eq.ADJUSTMENT,created_at.lte.${cutoff}`)
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
      .select('id, commission_amount_cents, reverses_ledger_id, kind, currency, created_at, payments(status)')
      .eq('partner_id', partnerId).is('payout_id', null).or('reverses_ledger_id.not.is.null,kind.eq.ADJUSTMENT').lt('created_at', runningStart)
    if (creditErr) throw creditErr
    const haveIds = new Set(unpaidLedger.map(l => l.id))
    for (const row of credits || []) if (isCreditRow(row) && !haveIds.has(row.id)) unpaidLedger.push(row)
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
      const { data: revs, error: rErr } = await selectInChunks(part => supabase.from('commission_ledger')
        .select('id, commission_amount_cents, reverses_ledger_id, kind, currency, created_at, payments(status)')
        .eq('partner_id', partnerId).is('payout_id', null).in('reverses_ledger_id', part), originalIds)
      if (rErr) throw rErr
      // Re-verified here rather than trusting the query alone: only a row that really is the
      // reversal of a selected original may ride along (never an unrelated/DISPUTED row).
      const wanted = new Set(originalIds)
      extra.push(...(revs || []).filter(r => r.reverses_ledger_id && wanted.has(r.reverses_ledger_id)))
    }
    if (missingOriginalIds.length) {
      const { data: origs, error: oErr } = await selectInChunks(part => supabase.from('commission_ledger')
        .select('id, commission_amount_cents, reverses_ledger_id, kind, currency, created_at, payments(status)')
        .eq('partner_id', partnerId).is('payout_id', null).in('id', part), missingOriginalIds)
      if (oErr) throw oErr
      const wanted = new Set(missingOriginalIds)
      extra.push(...(origs || []).filter(r => !r.reverses_ledger_id && wanted.has(r.id)))
    }
    for (const row of extra) if (!have.has(row.id)) { have.add(row.id); unpaidLedger.push(row) }
  }

  // Round 6 (bug): `currency` was any 3 characters ('usd' stored as-is) and was never compared with the
  // ledger rows being settled, so a payout could silently total commission earned in one currency and label
  // it another (the ledger has carried its own currency since 0051). Normalised, and refused on a mismatch.
  const envCurrency = c.activeCurrency(ctx.env)
  const currency = body.currency || envCurrency
  if (body.onlyCurrency) unpaidLedger = unpaidLedger.filter(l => String(l.currency || envCurrency).toUpperCase() === currency)
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

  const settledSpan = (() => {
    const times = unpaidLedger.filter(l => !l.reverses_ledger_id && l.kind !== 'ADJUSTMENT' && l.created_at)
      .map(l => Date.parse(l.created_at)).filter(Number.isFinite)
    if (!times.length) return {}
    return { start: new Date(Math.min(...times)).toISOString().slice(0, 10), end: new Date(Math.max(...times)).toISOString().slice(0, 10) }
  })()
  // ONE transaction (0087 record_payout_settlement): lock the partner, insert the payout, claim exactly the ledger rows that are
  // STILL unpaid and belong to this partner, and — when a concurrent payout had already taken some of them — correct the
  // figures or discard the payout, all before anything is visible. This used to be an insert, a chunked claim and a hand-rolled
  // compensation (delete / patch / alert) over separate PostgREST calls, so a failure in the middle left a payout whose commission
  // was still "owed" (and would be paid again in the next run).
  const ledgerIds = unpaidLedger.map(l => l.id)
  const { data: settlement, error } = await supabase.rpc('record_payout_settlement', {
    p_partner_id: partnerId,
    p_ledger_ids: ledgerIds,
    p_payout: {
      amount_cents:             amountCents,
      currency,
      payout_method:            payoutMethod,
      payout_details_snapshot:  partner.payout_details || {},
      settled_commission_cents: owedCents,
      note:                     body.note || null,
      internal_note:            body.internalNote || null,
      // Round 10: a batch ('ready') or ad hoc payout stored no period at all, so the payout history could not say
      // which sales a payout covered. With no explicit cycle the span is taken from the sales it actually settles.
      period_start:             body.periodStart ? body.periodStart.slice(0, 10) : (settledSpan.start || null),
      period_end:               body.periodEnd   ? body.periodEnd.slice(0, 10)   : (settledSpan.end || null)
    },
    p_discard_if_empty: autoAmount,
    p_amount_is_auto:   body.amountCents == null,
    // Round 29 (0110): the snapshot above was read earlier; the function re-checks, under the partner's row lock, that the details
    // were not changed in between, so the money is never recorded against an account the admin did not see.
    p_check_details:    true,
    p_expected_details_submitted_at: partner.payout_details_submitted_at ?? null
  })
  if (error) throw error
  if (settlement && settlement.details_changed)
    return reply({ success: false, code: 'PAYOUT_DETAILS_CHANGED',
      message: "This partner's payout details changed while the payout was being recorded. Nothing was recorded. Reload, check where the money should go, and try again." }, 409)

  let payoutRow = settlement.payout
  const claimedCount = settlement.claimed || 0
  const racedWithConcurrentPayout = settlement.requested > 0 && claimedCount < settlement.requested
  // The settlement is all-or-nothing now: a failure above throws and records nothing, so this can only ever be false.
  const ledgerSettlementFailed = false

  if (settlement.discarded) {
    // Auto-computed amount and this call won NOTHING (a concurrent payout took every row): this payout is a phantom —
    // nothing was kept, no "payout on its way" email is sent, the admin is told plainly.
    try {
      await emailService.sendOwnerAlert(ctx.env,
        'Payout recording lost a race — duplicate payout discarded',
        `partner: ${partner.name} <${partner.email}>\n\n` +
        `Two payout recordings overlapped for this partner and the other one settled every commission. ` +
        `Nothing was recorded by this call. Check the payout history before sending any more money.`, { dedupeKey: partnerId })
    } catch (_) {}
    return reply({ success: false, code: 'PAYOUT_RACED',
      message: 'Another payout was recorded for this partner at the same moment and already settled everything. Nothing was recorded here — check the payout history before sending any more money.' }, 409)
  }

  if (racedWithConcurrentPayout) {
    // A concurrent payout for this same partner claimed some of these rows first. The payout row genuinely happened (the admin
    // sent real money) so it is kept, with its figures already corrected inside the transaction: settled_commission_cents is
    // what THIS payout really settled, and amount_cents too when the amount was omitted (a typed amount is what was actually
    // transferred, so it is never rewritten — the alert below flags the mismatch).
    try {
      await emailService.sendOwnerAlert(ctx.env,
        'Payout recording raced a concurrent payout for the same partner',
        `partner: ${partner.name} <${partner.email}>\npayout id: ${payoutRow.id}\n` +
        `ledger rows requested: ${settlement.requested}\nledger rows this payout actually claimed: ${claimedCount}\n` +
        `recorded amount: ${payoutRow.amount_cents} cents\n\n` +
        `Another payout for this partner was recorded at almost the same moment (double-click, or two admin sessions). ` +
        `This payout's amount was ${body.amountCents == null ? 'automatically corrected to' : 'left as manually entered, despite'} ` +
        `only ${claimedCount} of ${settlement.requested} conversion(s) actually being available to settle here — ` +
        `review both payouts for this partner before their next payout run.`,
        { dedupeKey: partnerId }
      )
    } catch (_) {}
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
    amountCents:  z.number().int().positive().max(MAX_PAYOUT_CENTS, 'That amount is larger than the allowed maximum.'),
    confirmedTerms: z.boolean().optional(),
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
        confirmedTerms: item.confirmedTerms,
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
async function findPartnerByAnyToken(env, supabase, token, columns) {
  const dash = await partnerLinks.findPartnerByDashboardToken(env, supabase, token, columns)
  if (dash) return { partner: dash, scope: 'dashboard' }
  const [col, val] = await tokenLookup('payout_details_token', token)
  const { data, error } = await supabase.from('partners').select(`${columns}, dashboard_token_version`).eq(col, val).maybeSingle()
  if (error) throw error
  return data ? { partner: data, scope: 'payout' } : { partner: null, scope: null }
}

// What the payout page shows back to the link holder: names stay (so they recognise the destination), the
// number is cut to its last four digits.
// Partners round 42 (bug): the audit write for a BULK read of account numbers / tax IDs. logAdminAction swallows its own failures
// (right for ordinary actions) so the two bulk exports revealed everything with no trace when the write failed - unlike
// adminRevealPayoutDetails, which refuses. Returns false when the entry could not be written; the caller then reveals nothing.
async function auditBeforeReveal(ctx, supabase, action, targetType, targetId, detail = {}) {
  const actor = ctx.get && ctx.get('user')
  const { error } = await supabase.from('admin_audit_log').insert({
    actor_id: actor?.id || null, action, target_type: targetType, target_id: targetId == null ? null : String(targetId), detail })
  if (error) { console.error(`admin_audit_log insert failed (${action}):`, error.message); return false }
  return true
}
const auditUnavailable = ctx => ctx.json({ success: false, message: 'Could not record this access in the audit log, so nothing was shown. Try again.' }, 503)

function maskedPayoutDetailsForOwner(method, details) {
  return payoutRails.maskedPayoutDetails(method, details)
}

async function getPartnerByToken(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  const { data: partner, error } = await supabase
    .from('partners')
    .select(`name, payout_method, payout_details, payout_details_submitted_at, tax_country, tax_id, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`)
    .eq('payout_token_hash', await cryptoLib.sha256(token))
    .maybeSingle()
  if (error) throw error
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  // The payout page links on to the dashboard using the READ-ONLY token, so the
  // write-capable token never rides in a dashboard URL.
  // Section 4 round 9 (hardening): the link is a bearer credential that sits in an inbox, a browser history and
  // (via the legacy ?token= form) request logs, and this response used to hand back the FULL account / phone
  // number to whoever held it. The partner only needs to recognise what is on file, so the number comes back as
  // its last four digits; changing it means typing the new one (the page already makes them confirm it).
  return ctx.json({ success: true, data: {
    ...partnerRowToCamel({ ...partner, tax_id: null }),   // the full tax ID never rides a bearer link
    payoutDetails: maskedPayoutDetailsForOwner(partner.payout_method, partner.payout_details),
    payoutDetailsMasked: !!partner.payout_method,
    // Round 20: tax details — the ID comes back as its last four characters only, like the account number.
    taxCountry: partner.tax_country ?? '', taxIdMasked: last4Of(await fieldCrypto.openTaxId(ctx.env, partner.tax_id)),
    dashboardToken: await partnerLinks.dashboardTokenOf(ctx.env, partner)
  } })
}

// ── Public (token-gated): partner submits/updates their payout details ─────

// Round 4: both were bare "non-empty string" fields, so a typo'd account number or a
// phone number with letters was accepted and real money later went to the wrong place.
// Formats stay deliberately permissive (spaces/dashes allowed, IBANs and every national
// scheme fit) — this catches typos and junk, not every invalid account.
// Up to 42 characters: the longest IBAN (Malta, 31) is 38 with its spaces. The IBAN / local-format checks do the real validating.
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{3,41}$/
const PHONE_RE          = /^\+?\(?[0-9][0-9 ()\-]{6,19}$/
const bankDetailsSchema = z.object({
  payoutMethod:  z.literal('BANK'),
  bankName:      z.string().trim().min(1).max(200),
  accountName:   z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().regex(ACCOUNT_NUMBER_RE, 'Enter a valid account number (4–42 letters, digits, spaces or dashes).'),
  // Western-market round: where the account is held decides which routing details are needed (see lib/payoutRails.js).
  // All three are optional here so a submission without them (an older client, a script) still validates as before;
  // the superRefine below enforces the right combination once a country is given.
  bankCountry:   z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use the 2-letter country code of the country your account is in, e.g. US.').optional(),
  routingCode:   z.string().trim().max(20).optional(),
  swiftBic:      z.string().trim().max(11 + 3).optional()
})
const mobileMoneyDetailsSchema = z.object({
  payoutMethod: z.literal('MOBILE_MONEY'),
  provider:     z.string().trim().min(1).max(100),
  accountName:  z.string().trim().min(1).max(200),
  phoneNumber:  z.string().trim().regex(PHONE_RE, 'Enter a valid phone number with the country code, e.g. +1 415 555 0132.')
})
const paypalDetailsSchema = z.object({
  payoutMethod: z.literal('PAYPAL'),
  accountName:  z.string().trim().min(1).max(200),
  paypalEmail:  z.string().trim().max(254).regex(payoutRails.EMAIL_RE, 'Enter the email address of your PayPal account.')
})
// Round 20 (feature gap): tax details travel with the payout details but are NOT payout details — they never restart the
// post-change payout hold. Both optional: leaving a field out keeps what is on file, '' clears it.
const taxFields = {
  taxCountry: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code, e.g. US.').or(z.literal('')).optional(),
  taxId:      z.string().trim().min(3, 'Enter your tax ID, or leave it blank.').max(40).or(z.literal('')).optional()
}
const payoutDetailsSchema = z.discriminatedUnion('payoutMethod', [
  bankDetailsSchema.extend(taxFields), mobileMoneyDetailsSchema.extend(taxFields), paypalDetailsSchema.extend(taxFields)
]).superRefine((d, ctx) => {
  if (d.payoutMethod !== 'BANK') return
  for (const p of payoutRails.bankRailProblems(d)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p.path], message: p.message })
}).transform(d => d.payoutMethod === 'BANK' ? payoutRails.cleanBankDetails(d) : d)
// Tax IDs are only ever stored sealed (lib/fieldCrypto.js). Without the key a tax ID is refused, never stored in clear.
const taxStorageUnavailable = ctx => ctx.json({ success: false, code: 'TAX_STORAGE_UNAVAILABLE',
  message: 'Tax IDs can\u2019t be saved right now. Leave the tax ID blank and everything else will still save, or contact support.' }, 503)
const last4Of = v => { const raw = String(v || '').replace(/\s+/g, ''); return raw ? `\u2026${raw.slice(-4)}` : '' }

// Canonical form for comparing two payout-detail objects: same method, same keys, values compared with all
// whitespace removed and case folded (a re-typed "Equity  Bank" is not a change of destination).
function normalizedPayoutDetails(method, details) {
  const out = {}
  for (const key of Object.keys(details || {}).sort()) {
    const raw = String(details[key] ?? '')
    // Partners round 38: identifiers (numbers, codes, emails) ignore ALL spacing, but names are only space-COLLAPSED. Stripping every
    // space made "Jo Hn" and "John" the same destination, so that edit was saved silently - no hold, no owner alert.
    out[key] = (/number$|code$|email$|swiftbic$|bankcountry$/i.test(key) ? raw.replace(/\s+/g, '') : raw.trim().replace(/\s+/g, ' ')).toLowerCase()
  }
  return JSON.stringify([method || null, out])
}
// Round 23: spacing-collapsed but CASE-SENSITIVE comparison, to tell a cosmetic correction from a true re-submit.
function exactPayoutDetailsEqual(a, b) {
  const flat = d => JSON.stringify(Object.keys(d || {}).sort().map(k => [k,
    /number$/i.test(k) ? String(d[k] ?? '').replace(/\s+/g, '') : String(d[k] ?? '').trim().replace(/\s+/g, ' ')]))
  return flat(a) === flat(b)
}
function payoutDetailsEqual(methodA, detailsA, methodB, detailsB) {
  return !!methodA && normalizedPayoutDetails(methodA, detailsA) === normalizedPayoutDetails(methodB, detailsB)
}

// "BANK ...4821" / "MOBILE_MONEY ...5678" / "none" — enough to compare with the partner, never the full number.
// Round 8: what the partner's dashboard may show about the account on file - never the whole number.
function payoutAccountHint(method, details) {
  if (!method) return null
  const d = details || {}
  if (method === 'PAYPAL') return { method, provider: 'PayPal', last4: null, account: payoutRails.maskedEmail(d.paypalEmail) || null }
  const raw = payoutRails.accountIdentifier(d)
  return {
    method,
    provider: method === 'BANK' ? (d.bankName || null) : (d.provider || null),
    last4:    raw ? raw.slice(-4) : null
  }
}
// ISO time until which a payout-details change still holds payouts, or null when it no longer does.
function payoutHoldUntilOf(submittedAt, holdHours) {
  if (!submittedAt || !(holdHours > 0)) return null
  const until = Date.parse(submittedAt) + holdHours * 3600000
  return Number.isFinite(until) && until > Date.now() ? new Date(until).toISOString() : null
}

function describePayoutTarget(method, details) {
  if (!method) return 'none'
  if (method === 'PAYPAL') return `PAYPAL ${payoutRails.maskedEmail(details?.paypalEmail) || '(no email)'}`
  const raw = payoutRails.accountIdentifier(details)
  return `${method} ${raw ? `...${raw.slice(-4)}` : '(no number)'}`
}

async function submitPayoutDetails(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const rawBody = await ctx.req.json()
  // Tax-only save: no payoutMethod in the body means "leave my payout destination alone, just update the tax details".
  if (rawBody && typeof rawBody === 'object' && rawBody.payoutMethod === undefined) {
    const tax = z.object(taxFields).strict().parse(rawBody)
    const taxOnly = {}
    if (tax.taxCountry !== undefined) taxOnly.tax_country = tax.taxCountry || null
    if (tax.taxId !== undefined) {
      if (tax.taxId) {
        const sealed = await fieldCrypto.sealTaxId(ctx.env, tax.taxId)
        if (!sealed) return taxStorageUnavailable(ctx)
        taxOnly.tax_id = sealed
      } else taxOnly.tax_id = null
    }
    if (!Object.keys(taxOnly).length) return ctx.json({ success: false, message: 'Nothing to save.' }, 400)
    const supabaseTax = getSupabase(ctx.env)
    const { data: owner, error: taxErr } = await supabaseTax.from('partners')
      .update({ ...taxOnly, updated_at: new Date().toISOString() })
      .eq('payout_token_hash', await cryptoLib.sha256(token)).select('id').maybeSingle()
    if (taxErr) throw taxErr
    if (!owner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
    return ctx.json({ success: true, unchanged: true, message: 'Tax details saved.' })
  }
  const body = payoutDetailsSchema.parse(rawBody)
  const { payoutMethod, taxCountry, taxId, ...looseDetails } = body
  const details = payoutRails.canonicalPayoutDetails(looseDetails)
  const taxPatch = {}
  if (taxCountry !== undefined) taxPatch.tax_country = taxCountry || null
  if (taxId !== undefined) {
    if (taxId) {
      const sealed = await fieldCrypto.sealTaxId(ctx.env, taxId)
      if (!sealed) return taxStorageUnavailable(ctx)
      taxPatch.tax_id = sealed
    } else taxPatch.tax_id = null
  }
  const supabase = getSupabase(ctx.env)

  // Round 6: read what is being replaced so the owner alert can say WHAT changed (method + last 4 of the
  // account / phone, old -> new) — "details changed" alone gave nothing to check against the partner.
  const { data: previous, error: prevErr } = await supabase.from('partners')
    .select('payout_method, payout_details').eq('payout_token_hash', await cryptoLib.sha256(token)).maybeSingle()
  if (prevErr) throw prevErr
  if (!previous) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  // Section 4 round 7 (bug): the page pre-fills the saved details, so pressing Save without editing anything was
  // treated as a change — it restarted the payout hold, mailed the partner and the owner a "details changed"
  // alert, and let a leaked link freeze a partner's payouts indefinitely by re-submitting the same details. An
  // identical submission is now a no-op (spacing is ignored, like the confirm-field check on the page).
  if (payoutDetailsEqual(previous.payout_method, previous.payout_details, payoutMethod, details)) {
    // Round 23: "the same" ignores case and spacing so a re-submit cannot restart the payout hold, but a
    // case/spacing-only correction (e.g. an account name's capital letters) must still be STORED. It keeps the
    // original submitted-at (no hold, no alert), since it cannot move money anywhere new.
    const cosmetic = !exactPayoutDetailsEqual(previous.payout_details, details)
    const sameQuiet = { ...taxPatch, ...(cosmetic ? { payout_details: details } : {}) }
    if (Object.keys(sameQuiet).length) {
      const { error: taxErr } = await supabase.from('partners')
        .update({ ...sameQuiet, ...(cosmetic ? { updated_at: new Date().toISOString() } : {}) }).eq('payout_token_hash', await cryptoLib.sha256(token))
      if (taxErr) throw taxErr
    }
    return ctx.json({ success: true, unchanged: !cosmetic, message: 'Payout details saved.' })
  }

  const changedAt = new Date().toISOString()
  const { data, error } = await supabase.from('partners')
    .update({
      payout_method:                payoutMethod,
      payout_details:                details,
      payout_details_submitted_at:  changedAt,
      updated_at:                    changedAt,
      ...taxPatch
    })
    .eq('payout_token_hash', await cryptoLib.sha256(token))
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

  // Round 8: tell the partner, at the moment it matters, that a change pauses payouts for a while.
  const holdHours = payoutDetailsHoldHoursFor(ctx.env)
  return ctx.json({ success: true, message: 'Payout details saved.', payoutDetailsHoldHours: holdHours,
    payoutHoldUntil: payoutHoldUntilOf(changedAt, holdHours) })
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
    // Each row's own currency (null = the platform currency): a partner's ledger can span currencies after a currency change.
    currency:              row.currency ?? null,
    paid:                  !!row.payout_id,
    // Round 10: which payout settled this row (the dashboard's payout list carries the same id), so a partner can open
    // "the sales behind this payout" and reconcile what they received.
    payoutId:              row.payout_id || null,
    isReversal:            !!row.reverses_ledger_id,
    reversalReason:        row.reversal_reason ?? null,
    // Round 8: a manual admin entry (clawback / write-off / bonus) - shown to the partner WITH its reason.
    isAdjustment:          row.kind === 'ADJUSTMENT',
    adjustmentReason:      row.kind === 'ADJUSTMENT' ? (row.adjustment_reason ?? null) : null,
    // Round 16: the partner's own channel tag from the link (`?sub=`), null for an untagged sale.
    sub:                   row.kind === 'ADJUSTMENT' ? null : (row.attribution_sub ?? null),
    createdAt:             row.created_at
  }
}

// Section 4 round 11 (feature gaps): the dashboard had totals and three cycle rows but no sense of direction, and no
// idea HOW buyers reached the code. Both are derived from the ledger the dashboard already loads.
// Net commission and sales per cycle for the last `count` cycles (oldest first): sums include reversals and
// adjustments (they are signed), sales count real sales only (no reversals, no adjustments).
function buildCycleTrend(ledgerRows, count = 6) {
  const cycles = recentCycles(count).reverse()
  const byKey = new Map(cycles.map(cy => [cy.key, { key: cy.key, label: cy.label, isCurrent: cy.isCurrent, commissionCents: 0, sales: 0 }]))
  // Round 41 (bug): a sale that was later refunded still counted as a sale in its cycle, so the chart could say "5 sales" for a cycle
  // whose card (and the Conversions total) said 3. A reversed sale is not a sale; its commission and its reversal still net in the money.
  const reversed = new Set((ledgerRows || []).filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  for (const l of ledgerRows || []) {
    const b = byKey.get(cycleKey(l.created_at))
    if (!b) continue
    b.commissionCents += l.commission_amount_cents
    if (l.kind !== 'ADJUSTMENT' && !l.reverses_ledger_id && !reversed.has(l.id)) b.sales += 1
  }
  return cycles.map(cy => byKey.get(cy.key))
}
// How net sales reached the code: shared link, typed by hand, restored from the account. Refunded sales are
// excluded (same "net" rule as netConversionCount); rows from before attribution was recorded count as unknown.
function buildAttributionMix(ledgerRows) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  const out = { link: 0, typed: 0, account: 0, unknown: 0 }
  for (const l of rows) {
    if (l.kind === 'ADJUSTMENT' || l.reverses_ledger_id || reversed.has(l.id)) continue
    out[['link', 'typed', 'account'].includes(l.attribution_source) ? l.attribution_source : 'unknown'] += 1
  }
  return out
}

// Round 16 (feature gap): net sales per partner-chosen channel tag (`?ref=CODE&sub=newsletter`), most sales first. Same "net" rule
// as the attribution mix (refunded sales, reversals and adjustments are left out); untagged sales are not listed. Capped so a
// partner who tags every link differently cannot bloat the payload.
const SUB_MIX_MAX = 25
function buildSubMix(ledgerRows, subClicks) {
  const rows = ledgerRows || []
  const reversed = new Set(rows.filter(l => l.reverses_ledger_id).map(l => l.reverses_ledger_id))
  const by = new Map()
  for (const l of rows) {
    if (l.kind === 'ADJUSTMENT' || l.reverses_ledger_id || reversed.has(l.id) || !l.attribution_sub) continue
    const b = by.get(l.attribution_sub) || { sub: l.attribution_sub, sales: 0, commissionCents: 0, clicks: 0 }
    b.sales += 1
    b.commissionCents += l.commission_amount_cents || 0
    by.set(l.attribution_sub, b)
  }
  // Round 18: tags with visits but no sale yet still show (that is exactly the channel worth knowing about).
  for (const [sub, clicks] of Object.entries(subClicks || {})) {
    const b = by.get(sub) || { sub, sales: 0, commissionCents: 0, clicks: 0 }
    b.clicks = clicks
    by.set(sub, b)
  }
  return [...by.values()].sort((a, b) => b.sales - a.sales || b.clicks - a.clicks || a.sub.localeCompare(b.sub)).slice(0, SUB_MIX_MAX)
}

async function getPartnerDashboard(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)

  const supabase = getSupabase(ctx.env)
  // The dashboard opens with EITHER link: the dashboard link (read-only, derived or legacy-stored; what emails
  // carry now) or the legacy/payout token (links already sitting in old inboxes).
  // Two sequential exact-match lookups — never a user-supplied string inside an or()
  // filter. `scope` tells the page whether the holder may edit payout details directly.
  const dashSelect = `id, name, commission_rate, status, payout_method, payout_details, payout_details_submitted_at, terms_version, notify_conversions,
      referral_codes(id, partner_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at),
      payouts(id, partner_id, amount_cents, currency, payout_method, status, note, settled_commission_cents, period_start, period_end, paid_at, created_at, voided_at)`
  const decorate = q => q
    .order('paid_at',    { foreignTable: 'payouts',        ascending: false })
    .order('created_at', { foreignTable: 'referral_codes', ascending: false })
  let scope = 'dashboard'
  let partner = await partnerLinks.findPartnerByDashboardToken(ctx.env, supabase, token, dashSelect, decorate)
  if (!partner) {
    const [lookupCol, lookupVal] = await tokenLookup('payout_details_token', token)
    const res = await decorate(supabase.from('partners').select(dashSelect).eq(lookupCol, lookupVal)).maybeSingle()
    if (res.error) throw res.error
    partner = res.data || null
    scope = 'payout'
  }
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  // Round 27: the ledger is read in keyset pages (see loadLedgerForPartner), not embedded in the partner query.
  partner.commission_ledger = await loadLedgerForPartner(supabase, partner.id,
    'id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, currency, payout_id, reverses_ledger_id, adjusts_ledger_id, reversal_reason, kind, adjustment_reason, attribution_source, attribution_sub, created_at, payments(status)')

  const ledger = partner.commission_ledger || []
  const codes  = partner.referral_codes || []
  // Round 18: visits per channel tag, summed over this partner's codes. Best-effort: a failed read only hides the click column.
  const subClicks = {}
  try {
    const ids = codes.map(rc => rc.id).filter(Boolean)
    if (ids.length) {
      // Round 20 (bug): unordered and unlimited, so a flood of junk tags (the track-click endpoint is public) could push the read past
      // PostgREST's row cap and silently drop a partner's real channels. Most-visited first, bounded; migration 0099 also caps
      // distinct tags per code at write time.
      const { data: scRows, error: scErr } = await supabase.from('referral_sub_clicks').select('sub, clicks')
        .in('code_id', ids).order('clicks', { ascending: false }).limit(500)
      if (scErr) throw scErr
      for (const r of scRows || []) subClicks[r.sub] = (subClicks[r.sub] || 0) + (r.clicks || 0)
    }
  } catch (err) { console.error('dashboard sub clicks:', err.message) }

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

  // Partners round 40: after "Request a code" the partner saw nothing again. Return the newest request so the dashboard can say whether it
  // is still waiting, was answered, or was closed. Best effort - a database without migration 0116 just has none.
  let codeRequest = null
  try {
    const { data: reqRow, error: reqErr } = await supabase.from('partner_code_requests')
      .select('status, wanted_code, created_at, resolved_at').eq('partner_id', partner.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!reqErr && reqRow) codeRequest = { status: reqRow.status, wantedCode: reqRow.wanted_code ?? null, createdAt: reqRow.created_at, resolvedAt: reqRow.resolved_at ?? null }
  } catch (_) { codeRequest = null }

  return ctx.json({ success: true, data: {
    name:           partner.name,
    commissionRate: Number(partner.commission_rate),
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
    // Round 20: PAUSED (temporary) vs ENDED (membership over) read differently on the partner's own page.
    status:         partner.status,
    // Single platform-wide currency (env.PAYSTACK_CURRENCY) — see the matching
    // fix in adminListPartners/adminGetPartner above. Without this,
    // PartnerDashboard.jsx's Pending/Paid stats and per-tier prices always
    // rendered as USD regardless of what's actually configured.
    currency:       c.activeCurrency(ctx.env),
    // Unpaid commission per currency. When the platform currency has been changed the ledger can hold more than one, and the
    // headline totals add raw cents; the page uses these two fields to say so and to show each currency on its own.
    unpaidByCurrency: unpaidByCurrency(ledger, c.activeCurrency(ctx.env)),
    mixedCurrency:    Object.keys(unpaidByCurrency(ledger, c.activeCurrency(ctx.env))).length > 1,
    // Per-code conversions + conversion rate (clicks -> sales), net of refunds.
    // partnerId is an internal id with no partner-facing purpose — dropped here (round 5).
    referralCodes:  (await attachSignupCounts(supabase, attachCodeStats(codes.map(referralCodeRowToCamel), ledger, codes))).map(({ partnerId, ...rc }) => ({
      ...rc, stats: { conversions: rc.stats.conversions, conversionRate: rc.stats.conversionRate, commissionCents: rc.stats.commissionCents }   // round 27: earnings per code (net of reversals); gross sale value stays admin-only
    })),
    notifyConversions: partner.notify_conversions !== false,
    codeRequest,
    // Round 8: where payouts go (method + provider/bank + last four only - the full number never rides the
    // read-only dashboard), when a recent change is still holding payouts, and the terms prompt.
    payoutAccount:    payoutAccountHint(partner.payout_method, partner.payout_details),
    payoutHoldUntil:  payoutHoldUntilOf(partner.payout_details_submitted_at, payoutDetailsHoldHoursFor(ctx.env)),
    termsAcceptanceRequired: partner.terms_version !== PARTNER_TERMS_VERSION,
    // Round 42: with PAYOUT_REQUIRES_CURRENT_TERMS on, the next payout run holds this partner back until they accept (or the admin confirms).
    payoutBlockedByTerms: payoutRequiresCurrentTerms(ctx.env) && partner.terms_version !== PARTNER_TERMS_VERSION,
    currentTermsVersion:     PARTNER_TERMS_VERSION,
    acceptedTermsVersion:    partner.terms_version ?? null,
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
    trend:          buildCycleTrend(ledger, 6),
    attributionMix: buildAttributionMix(ledger),
    subMix:         buildSubMix(ledger, subClicks),
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
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id')
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const { limit, offset } = pageParams(ctx)

  // Round 10: optional `payoutId` narrows the list to the rows one payout settled (the "sales behind this payout" view);
  // `unpaid=true` to what is still waiting. A malformed id matches nothing rather than erroring.
  const wantedPayoutId = ctx.req.query('payoutId')
  let ledgerQuery = supabase.from('commission_ledger')
    .select('id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, currency, payout_id, reverses_ledger_id, reversal_reason, kind, adjustment_reason, attribution_sub, created_at', { count: 'exact' })
    .eq('partner_id', partner.id)
  if (wantedPayoutId) ledgerQuery = UUID_RE.test(wantedPayoutId) ? ledgerQuery.eq('payout_id', wantedPayoutId) : ledgerQuery.eq('id', '00000000-0000-0000-0000-000000000000')
  else if (ctx.req.query('unpaid') === 'true') ledgerQuery = ledgerQuery.is('payout_id', null)
  // Partners round 38: narrow by one code and/or a date range (UTC days, inclusive). A malformed value matches nothing instead of being ignored,
  // so a CSV built from a filter can never silently contain everything.
  const wantedCode = ctx.req.query('codeId')
  if (wantedCode) ledgerQuery = UUID_RE.test(wantedCode) ? ledgerQuery.eq('referral_code_id', wantedCode) : ledgerQuery.eq('id', '00000000-0000-0000-0000-000000000000')
  const dayOf = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`)) ? String(v) : null)
  const fromQ = ctx.req.query('from'), toQ = ctx.req.query('to')
  if (fromQ) { const d = dayOf(fromQ); ledgerQuery = d ? ledgerQuery.gte('created_at', `${d}T00:00:00.000Z`) : ledgerQuery.eq('id', '00000000-0000-0000-0000-000000000000') }
  if (toQ) { const d = dayOf(toQ); ledgerQuery = d ? ledgerQuery.lt('created_at', new Date(Date.parse(`${d}T00:00:00.000Z`) + 86400000).toISOString()) : ledgerQuery.eq('id', '00000000-0000-0000-0000-000000000000') }
  const [codesRes, ledgerRes] = await Promise.all([
    supabase.from('referral_codes').select('id, code').eq('partner_id', partner.id),
    ledgerQuery
      .order('created_at', { ascending: false }).order('id', { ascending: true })
      .range(offset, offset + limit - 1)
  ])
  if (codesRes.error) throw codesRes.error
  if (ledgerRes.error) throw ledgerRes.error
  const codeTextById = new Map((codesRes.data || []).map(r => [r.id, r.code]))
  return ctx.json({ success: true, total: ledgerRes.count ?? null,
    currency: c.activeCurrency(ctx.env),
    data: (ledgerRes.data || []).map(row => conversionRowOf(row, codeTextById)) })
}

async function requestPayoutLink(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  const { partner, scope } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id, name, email')
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  if (isRemovedEmail(partner.email)) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  // Round 29: a holder of the READ-ONLY dashboard link (a forwarded earnings email) could call this in a loop and kill the partner's
  // current payout link each time. One swap per 15 minutes for that scope; the answer stays the same neutral message.
  // Round 31: the key is set only AFTER an email really went out. Set before the send, a failed send (link restored) still silenced
  // the partner's retries for 15 minutes with the same "we've emailed it" answer and nothing in their inbox.
  const throttleKey = scope === 'dashboard' ? `partner-payout-link-self:${partner.id}` : null
  if (throttleKey && await referralService.keySeen(ctx.env, throttleKey))
    return ctx.json({ success: true, message: 'If your link is valid, we\'ve emailed the payout-details link to the address we have on file.' })
  // Round 16: the stored token is a hash, so a link can only be "sent" by minting a new one — which kills the previous link. That
  // swap used to happen BEFORE the email and its result was ignored, so a send that failed or hit the 4-per-hour cap left the
  // partner with a dead link and nothing in their inbox. Same pattern as resetMyPartnerLinks: remember what was there, swap
  // with a guard, send, and put the old hash back if the email did not go.
  const { data: before, error: beforeErr } = await supabase.from('partners').select('payout_token_hash').eq('id', partner.id).maybeSingle()
  if (beforeErr) throw beforeErr
  const newRaw = cryptoLib.randomToken(32)
  const newHash = await cryptoLib.sha256(newRaw)
  const { data: swapped, error: swapErr } = await supabase.from('partners')
    .update({ ...(await payoutTokenFields(newRaw)), updated_at: new Date().toISOString() })
    .eq('id', partner.id).select('id').maybeSingle()
  if (swapErr) throw swapErr
  if (swapped) {
    const payoutUrl = `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${newRaw}`
    // Own quota key: the partner's button must not share a 4-per-hour budget with admin
    // create/resend of the same template (round 5).
    const sent = await emailService.sendPartnerPayoutDetailsRequest(ctx.env, supabase, partner.email, partner.name, payoutUrl, { quotaKey: 'partner_payout_link_self' }).catch(() => false)
    if (!sent) {
      // Restore the link they already had (only if nothing else rotated it meanwhile).
      const { error: undoErr } = await supabase.from('partners')
        .update({ payout_token_hash: before?.payout_token_hash ?? null })
        .eq('id', partner.id).eq('payout_token_hash', newHash)
      if (undoErr) console.error('requestPayoutLink undo:', undoErr.message)
    } else if (throttleKey) {
      await referralService.keyMark(ctx.env, throttleKey, 900).catch(() => {})
    }
  }
  // Neutral either way (this route must not become a way to probe the quota or the mail provider).
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
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id')
  if (!partner) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const { error } = await supabase.from('partners')
    .update({ notify_conversions: body.conversions, updated_at: new Date().toISOString() }).eq('id', partner.id)
  if (error) throw error
  return ctx.json({ success: true, data: { notifyConversions: body.conversions } })
}

const CODE_FORMAT_RE = /^[A-Z0-9_-]{2,50}$/
const BOT_UA = /bot\b|crawl|spider|slurp|preview|headless|facebookexternalhit|curl\/|wget|python-requests|httpclient|monitor|lighthouse/i

async function trackClick(ctx) {
  // `null`, a number or an array are valid JSON that parse fine and then blow up on `.code` — treat as empty.
  const parsedBody = await ctx.req.json().catch(() => null)
  const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody) ? parsedBody : {}
  const code = String(body.code || '').trim().toUpperCase()
  if (!code) return ctx.json({ success: true })
  // Section 4 round 7 (bug): an over-long or malformed value (`?ref=` is a generic parameter) got a bare success,
  // so the browser kept it and it replaced a real partner's stored attribution. Say plainly it is not a code.
  if (!CODE_FORMAT_RE.test(code)) return ctx.json({ success: true, valid: false })
  const ua = ctx.req.header?.('user-agent') || ''
  // `bot\b` also matches real handsets such as "CUBOT P40" (a brand sold in Africa), whose clicks were silently dropped.
  if (!ua || (BOT_UA.test(ua) && !/cubot/i.test(ua))) return ctx.json({ success: true })

  const supabase = getSupabase(ctx.env)
  // Round 6 (feature gap / bug): `?ref=` is a generic query parameter (`?ref=producthunt`, `?ref=twitter`), and
  // this always answered success — so the browser stored whatever it was given, overwrote a REAL partner's
  // attribution with junk and showed the buyer "that code doesn't look right". The answer now says whether the
  // code is one that could actually apply (exists, active, unexpired, under its limit, partner active) so the
  // client keeps only those. `valid` is omitted when it can't be determined (lookup failed) — the client then
  // keeps the code, as before.
  let valid, retry = false
  try {
    const looked = await lookupCode(supabase, code)
    // Partners round 38: a code of a PAUSED partner is not applying right now but may again within the buyer's 30 days. Answering a bare
    // "invalid" made the browser delete the visitor's stored code, so the partner lost the attribution for good. `retry` says keep it.
    retry = !!(looked && !looked.user_id && looked.partners?.status === 'PAUSED')
    // Round 29: a personal welcome code prices for ONE account only. Called "valid" it was stored as the visitor's attribution and
    // replaced a real partner's code with one that can never apply (so nobody was credited). It is not a shareable partner link.
    valid = looked && looked.user_id ? false : isCodeUsable(looked)
  } catch (err) {
    console.error('trackClick lookup:', err.message)
  }
  if (valid === false) return ctx.json({ success: true, valid: false, ...(retry ? { retry: true } : {}) })
  // Round 29: one visitor counts once per code per 30 minutes (a script or a refresh loop used to inflate clicks and skew the
  // conversion rate). Needs the KV; without it every click counts, as before.
  let ipKey = ''
  try { ipKey = (await cryptoLib.sha256(String(clientIp(ctx) || ''))).slice(0, 24) } catch (_) { ipKey = '' }
  const seenClick = async (suffix) => {
    if (!ipKey || typeof referralService.keySeen !== 'function') return false
    const key = `referral-click:${code}:${suffix}:${ipKey}`
    if (await referralService.keySeen(ctx.env, key)) return true
    await referralService.keyMark(ctx.env, key, 1800)
    return false
  }
  // Round 19: `subOnly` is a returning visitor arriving through a DIFFERENT channel tag of the same code. The code's own click
  // counter is for new attributions, so it is left alone; only the channel's visit is counted.
  if (body.subOnly !== true && !(await seenClick('c'))) {
    const { error } = await supabase.rpc('increment_referral_code_clicks', { p_code: code })
    if (error) console.error('trackClick:', error.message)
  }
  // Round 18 (feature gap): the channel tag is counted per code too, so the partner sees visits and conversion by channel.
  const sub = normalizeSub(body.sub)
  if (sub && !(await seenClick(`s-${sub}`))) {
    const { error: subErr } = await supabase.rpc('increment_referral_sub_clicks', { p_code: code, p_sub: sub })
    if (subErr) console.error('trackClick sub:', subErr.message)
  }
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
const PARTNER_TERMS_VERSION = '2026-10b'   // round 37: bumped with the PayPal + tax paragraph added to PartnerTerms.jsx (the text changed, the version had not)

const applicationSchema = z.object({
  name:     z.string().trim().min(1).max(200),
  email:    partnerEmailSchema,
  audience: z.string().trim().max(1000).optional(),
  website:  z.string().trim().max(300).optional(),
  message:  z.string().trim().max(2000).optional(),
  // Honeypot: real people never see/fill this field.
  company:  z.string().max(200).optional(),
  // Round 6 (feature gap): applying now records acceptance of the program terms (/partner/terms). Required —
  // `true` or the request is refused — so no application exists without one.
  // Partners round 38: the version of the terms the applicant was shown; a mismatch is refused so nobody accepts text they did not see.
  termsVersion: z.string().trim().max(40).optional(),
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
  // Round 41 (bug): the version was optional, and an application without one skipped this check yet was stamped with the CURRENT version
  // as accepted. The form swallowed a failed /program fetch and sent none, so an applicant could "accept" terms the page never loaded.
  // It is required now; the form blocks submit until it has the version (and an older cached form is told to reload).
  if (body.termsVersion === undefined)
    return ctx.json({ success: false, code: 'TERMS_VERSION_REQUIRED', currentTermsVersion: PARTNER_TERMS_VERSION,
      message: 'Reload this page to read the current partner terms, then apply.' }, 409)
  if (body.termsVersion !== PARTNER_TERMS_VERSION)
    return ctx.json({ success: false, code: 'TERMS_VERSION_CHANGED', currentTermsVersion: PARTNER_TERMS_VERSION,
      message: 'The partner terms were updated while this page was open. Reload to read the current version, then apply.' }, 409)

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

  const appliedAt = new Date().toISOString()
  const { error } = await supabase.from('partner_applications').insert({
    name: body.name, email: body.email,
    audience: body.audience || null, website: body.website || null, message: body.message || null,
    terms_accepted_at: appliedAt, terms_version: PARTNER_TERMS_VERSION
  })
  if (error) {
    if (error.code === '23505') return ctx.json(APPLY_OK)   // already has a pending application
    throw error
  }
  await logTermsAcceptance(ctx, supabase, { applicationEmail: body.email.toLowerCase(), version: PARTNER_TERMS_VERSION, source: 'application', acceptedAt: appliedAt })

  // Round 16: both mails ran inline, so a request that stored a NEW application took visibly longer (two provider round-trips) than
  // every silent path above (existing partner, cooldown, duplicate pending) that answers at once — a timing oracle for "is this
  // address already a partner / recently rejected / already pending". Now both go out after the response, like recoverPartnerLinks.
  // Round 6 (kept): the applicant is told it arrived; only an application that was actually stored gets here.
  runInBackground(ctx, emailService.sendOwnerAlert(ctx.env, 'New partner application',
    `name: ${body.name}\nemail: ${body.email}\nwebsite: ${body.website || '-'}\n\nReview it under Admin -> Partners -> Applications.`,
    { dedupeKey: body.email.toLowerCase() }).catch(() => {}))
  runInBackground(ctx, emailService.sendPartnerApplicationReceived(ctx.env, supabase, body.email, body.name).catch(() => {}))
  return ctx.json(APPLY_OK)
}

// Public: the live numbers behind the terms page, so it never states a hold period or minimum that differs from
// what the payout run actually enforces.
async function getProgramTerms(ctx) {
  return ctx.json({ success: true, data: {
    termsVersion:          PARTNER_TERMS_VERSION,
    currency:              c.activeCurrency(ctx.env),
    holdDays:              holdDaysFor(ctx.env),
    minPayoutCents:        minPayoutFor(ctx.env),
    payoutDetailsHoldHours: payoutDetailsHoldHoursFor(ctx.env),
    reapplyCooldownDays:   REAPPLY_COOLDOWN_DAYS
  } })
}

async function adminListApplications(ctx) {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(ctx.req.query('status')) ? ctx.req.query('status') : 'PENDING'
  const supabase = getSupabase(ctx.env)
  // Section 4 round 7 (feature gap): the list was hard-capped at 200 rows with no way to see older ones, and the
  // "N waiting" badge counted that capped list. Paged, with the true total.
  const { limit, offset } = pageParams(ctx)
  const { data, error, count } = await supabase.from('partner_applications').select('*', { count: 'exact' })
    .eq('status', status).order('created_at', { ascending: false }).order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, reapplyCooldownDays: REAPPLY_COOLDOWN_DAYS, total: count ?? null, data: (data || []).map(applicationRowToCamel) })
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
  // Section 4 round 11 (bug): the first code made here skipped the price guardrails every other code path has
  // (adminCreateReferralCode / adminUpdateReferralCode). Judge it BEFORE anything is claimed, so a refusal is clean.
  const approveGuard = body.referralCode ? priceGuardrails(ctx.env, body.referralCode.tierPrices) : { tooLow: [], noDiscount: [] }
  if (approveGuard.tooLow.length && !body.referralCode.confirmLowPrice) return lowPriceResponse(ctx, approveGuard)
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
  // Round 8: this error was ignored. The link is what erasure follows (adminAnonymizePartner deletes the
  // application by partner_id, and by email only as a fallback that an email change defeats), so retry once and
  // make a persistent failure loud instead of leaving an application that erasure cannot find.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error: linkErr } = await supabase.from('partner_applications').update({ partner_id: made.data.id }).eq('id', appId)
    if (!linkErr) break
    if (attempt === 1) console.error('adminApproveApplication: could not link application to partner:', appId, linkErr.message)
  }

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
        await partnerLinks.dashboardUrlOf(ctx.env, made.data)).catch(() => {})
      await logAdminAction(ctx, supabase, 'partner.referral_code_created', 'referral_code', codeRow.id, {
        partnerId: made.data.id, codeId: codeRow.id, tierPrices: codeRow.tier_prices, fromApplication: appId
      })
    }
  }
  await logAdminAction(ctx, supabase, 'partner.application_approved', 'partner_application', appId, { partnerId: made.data.id, commissionRate: made.data.commission_rate })
  return ctx.json({ success: true, data: partnerRowToCamel(made.data), codeCreated, codeError, ...(guardWarnings(approveGuard).length ? { warnings: guardWarnings(approveGuard) } : {}), emailed: made.emailed, ...(made.payoutUrl ? { payoutUrl: made.payoutUrl } : {}) })
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

// Round 20 (feature gap): a rejection could not be taken back. Approve only works on a PENDING row and the applicant is locked out
// for the re-apply cooldown, so a mistaken click meant creating the partner by hand. Reopening puts the SAME application back in the
// waiting list (review fields cleared); it sends nothing — the applicant hears again only when it is approved or rejected.
async function adminReopenApplication(ctx) {
  const appId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase.from('partner_applications')
    .update({ status: 'PENDING', reviewed_at: null, review_note: null })
    .eq('id', appId).eq('status', 'REJECTED').select('id, name').maybeSingle()
  if (error && error.code === '23505')
    return ctx.json({ success: false, message: 'That applicant already has another application waiting. Review that one instead.' }, 409)
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'Only a rejected application can be reopened.' }, 404)
  await logAdminAction(ctx, supabase, 'partner.application_reopened', 'partner_application', appId, {})
  return ctx.json({ success: true })
}

// ── Admin: void a payout recorded in error ──────────────────────────────────
// Recording was one-way: a wrong amount / partner / cycle meant hand-written SQL. Voiding
// keeps the payout row (audit trail) with voided_at set and RELEASES the ledger rows it
// settled (payout_id back to NULL), so the commission is owed again and every payable /
// pending / dashboard figure — all derived from ledger.payout_id — corrects itself.
// One transaction (0087 void_payout): the void mark and the release commit together, and a repeat call on a
// payout that is already void simply re-confirms the release.
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

  // ONE transaction (0087 void_payout): mark the payout void AND release the ledger rows it settled. A repeat call on a payout that
  // is already void just re-confirms the release. (This used to be a claim UPDATE followed by a separate release UPDATE, with a
  // "run Void again" message for when the second one failed in between.)
  const { data: voided, error: voidErr } = await supabase.rpc('void_payout', {
    p_payout_id: payoutId, p_partner_id: partnerId, p_reason: body.reason
  })
  if (voidErr) throw voidErr
  if (!voided) return ctx.json({ success: false, message: 'Payout not found.' }, 404)
  const alreadyVoided = !!voided.already_voided
  const released = Array.from({ length: voided.released || 0 })

  if (!alreadyVoided) {
    await logAdminAction(ctx, supabase, 'partner.payout_voided', 'payout', payoutId, {
      partnerId, amountCents: payout.amount_cents, releasedRows: (released || []).length, reason: body.reason
    })
    if (body.notifyPartner !== false) {
      const { data: partner } = await supabase.from('partners').select('name, email').eq('id', partnerId).maybeSingle()
      if (partner && !isRemovedEmail(partner.email)) await emailService.sendPartnerPayoutVoided(ctx.env, supabase, partner.email, partner.name,
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
    .select('id, partner_id, user_id, code, tier_prices, active, usage_limit, uses_so_far, clicks, expires_at, created_at, partners(name, email, status)', { count: 'exact' })
  if (q) query = query.ilike('code', `%${q}%`)
  // Round 29: one personal welcome code exists per account and used to bury every partner code in this list. Hidden unless asked for.
  // A search by text still finds a personal code (support: "my code FN-ABCDE did not work"); only the unfiltered list hides them.
  if (ctx.req.query('personal') === 'true') query = query.not('user_id', 'is', null)
  else if (!q) query = query.is('user_id', null)
  const active = ctx.req.query('active')
  if (active === 'true' || active === 'false') query = query.eq('active', active === 'true')
  const partnerId = ctx.req.query('partnerId')
  if (partnerId && UUID_RE.test(partnerId)) query = query.eq('partner_id', partnerId)
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, data: (data || []).map(r => ({
    ...referralCodeRowToCamel(r),
    personal: !!r.user_id || isSystemPartnerId(r.partner_id),
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
  // Round 10: a date-only `to` (2026-09-30) parsed as midnight UTC, so everything paid ON the last day was excluded.
  // A bare date now means "through the end of that day".
  if (to && !Number.isNaN(Date.parse(to))) {
    const toMs = /^\d{4}-\d{2}-\d{2}$/.test(to.trim()) ? Date.parse(to) + 86400000 - 1 : Date.parse(to)
    query = query.lte('paid_at', new Date(toMs).toISOString())
  }
  const { data, error, count } = await query.order('paid_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, currency: c.activeCurrency(ctx.env), data: (data || []).map(r => ({
    ...payoutRowToCamel(r), partnerName: r.partners?.name ?? null, partnerEmail: r.partners?.email ?? null
  })) })
}

// Pages through one numeric column so a total is never silently cut at PostgREST's row cap.
async function sumPaged(makeQuery, column) {
  let total = 0, last = null   // keyset on id (round 27): offsets skip rows when the filtered set shrinks mid-scan
  for (;;) {
    let q = makeQuery()
    if (last) q = q.gt('id', last)
    const { data, error } = await q.order('id', { ascending: true }).limit(1000)
    if (error) throw error
    for (const r of data || []) total += Number(r[column]) || 0
    if (!data || data.length < 1000) break
    last = data[data.length - 1].id
  }
  return total
}

// Sums one numeric column per group (partner), paged — so a partner's unpaid refund credit nets against THEIR OWN
// sales only and never against another partner's balance.
async function sumPagedBy(makeQuery, column, groupColumn) {
  const byGroup = new Map()
  let last = null
  for (;;) {
    let q = makeQuery()
    if (last) q = q.gt('id', last)
    const { data, error } = await q.order('id', { ascending: true }).limit(1000)
    if (error) throw error
    for (const r of data || []) byGroup.set(r[groupColumn], (byGroup.get(r[groupColumn]) || 0) + (Number(r[column]) || 0))
    if (!data || data.length < 1000) break
    last = data[data.length - 1].id
  }
  return byGroup
}

async function adminPartnersOverview(ctx) {
  const supabase = getSupabase(ctx.env)
  const head = (table, apply) => apply(supabase.from(table).select('id', { count: 'exact', head: true }))
  // Round 33: the money totals used to page through EVERY payout and ledger row on each load (twice over the ledger); past ~500k rows that
  // exceeds the Worker's subrequest budget. One SQL function (migration 0112) returns them. A database that has not had 0112 yet (or a
  // fake that answers nothing) falls back to the old scan, so deploying the Worker first never breaks this page.
  const totalsCall = supabase.rpc('partners_overview_totals', { p_exclude_partner: WELCOME_PARTNER_ID }).then(r => r, e => ({ data: null, error: e }))
  const [partnersRes, activeRes, pendingAppsRes, totalsRes] = await Promise.all([
    head('partners', q => q.neq('id', WELCOME_PARTNER_ID)),
    head('partners', q => q.eq('status', 'ACTIVE').neq('id', WELCOME_PARTNER_ID)),
    head('partner_applications', q => q.eq('status', 'PENDING')),
    totalsCall
  ])
  for (const r of [partnersRes, activeRes, pendingAppsRes]) if (r.error) throw r.error
  let paidOutCents, owedCents = 0, creditCents = 0, earnedCents
  const t = totalsRes && !totalsRes.error && totalsRes.data && typeof totalsRes.data === 'object' ? totalsRes.data : null
  if (t) {
    paidOutCents = Number(t.paid_out_cents) || 0; earnedCents = Number(t.lifetime_commission_cents) || 0
    owedCents = Number(t.owed_cents) || 0; creditCents = Number(t.credit_cents) || 0
  } else {
    const [paid, unpaidByPartner, earned] = await Promise.all([
      sumPaged(() => supabase.from('payouts').select('id, amount_cents').is('voided_at', null), 'amount_cents'),
      sumPagedBy(() => supabase.from('commission_ledger').select('id, partner_id, commission_amount_cents').is('payout_id', null).neq('partner_id', WELCOME_PARTNER_ID), 'commission_amount_cents', 'partner_id'),
      sumPaged(() => supabase.from('commission_ledger').select('id, commission_amount_cents').neq('partner_id', WELCOME_PARTNER_ID), 'commission_amount_cents')
    ])
    paidOutCents = paid; earnedCents = earned
    for (const v of unpaidByPartner.values()) { if (v > 0) owedCents += v; else creditCents += -v }
  }
  return ctx.json({ success: true, data: {
    partners: partnersRes.count ?? 0, activePartners: activeRes.count ?? 0, pendingApplications: pendingAppsRes.count ?? 0,
    paidOutCents, owedCents, creditCents, lifetimeCommissionCents: earnedCents,
    currency: c.activeCurrency(ctx.env)
  } })
}

// ── Public: "I lost my link" — email me my dashboard link (Section 4 round 7, feature gap) ──────────────────
// A partner who deleted their emails had no way back in: every partner endpoint needs a token, and the only
// self-serve resend (requestPayoutLink) needs one too. This takes the address on file and mails the READ-ONLY
// dashboard link (the write-capable payout link stays one click further, behind the dashboard's own
// "email me a payout-details link" button). It answers the same way whether or not the address belongs to a
// partner, does its sending after the response so timing doesn't tell either, and is bounded per IP (own
// limiter bucket), per recipient (own email quota) and by Turnstile where the deployment has it.
const recoverLinksSchema = z.object({
  email:   z.string().trim().email().max(320),
  company: z.string().max(200).optional(),   // honeypot
  turnstileToken: z.string().max(2048).nullish()
})
const RECOVER_OK = { success: true, message: "If that address belongs to a partner, we've emailed their dashboard link to it." }

async function recoverPartnerLinks(ctx) {
  noStore(ctx)
  const body = recoverLinksSchema.parse(await ctx.req.json())
  if (body.company) return ctx.json(RECOVER_OK)
  if (!(await verifyTurnstile(ctx.env, body.turnstileToken, clientIp(ctx))))
    return ctx.json({ success: false, code: 'CAPTCHA_FAILED', message: 'We couldn\u2019t verify that you\u2019re human. Please try again.' }, 400)

  const supabase = getSupabase(ctx.env)
  const exact = String(body.email).replace(/[\\%_]/g, '\\$&')
  const { data, error } = await supabase.from('partners')
    .select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).ilike('email', exact).limit(1)
  if (error) throw error
  const partner = (data || [])[0]
  if (partner && !isRemovedEmail(partner.email)) {
    const dashboardUrl = await partnerLinks.dashboardUrlOf(ctx.env, partner)
    runInBackground(ctx, emailService.sendPartnerLinksRecovery(ctx.env, supabase, partner.email, partner.name, dashboardUrl).catch(() => false))
  }
  return ctx.json(RECOVER_OK)
}

// ── Admin: remove a partner's personal data (Section 4 round 7, feature gap) ─────────────────────────────────
// There was no way to offboard a partner or honour an erasure request: partners, payouts, referral codes and
// ledger rows reference each other with no cascade, and name / email / bank details sat on the row forever.
// Deleting the row would destroy payment records that must be kept, so this ANONYMIZES instead: identity,
// contact, payout details and bearer tokens are wiped, codes are switched off, the application records are
// deleted, and each past payout's account snapshot is cut down to bank/provider + last four digits. Money
// rows (ledger, payout amounts and dates) are untouched. Refused while any commission is still owed — settle
// or void it first, so nobody is anonymized with money outstanding. Idempotent and resumable: the partner row
// itself is changed LAST, so a failure part-way leaves the original email in place for the retry to find.
const anonymizePartnerSchema = z.object({ reason: z.string().trim().min(3, 'Say why this partner\u2019s data is being removed.').max(300) })

function maskedPayoutSnapshot(method, snapshot) {
  const s = snapshot || {}
  const last4 = v => { const raw = String(v || '').replace(/\s+/g, ''); return raw ? `\u2026${raw.slice(-4)}` : '' }
  if (method === 'BANK') return { bankName: s.bankName || '', accountName: 'Removed', accountNumber: last4(s.accountNumber) }
  if (method === 'MOBILE_MONEY') return { provider: s.provider || '', accountName: 'Removed', phoneNumber: last4(s.phoneNumber) }
  if (method === 'PAYPAL') return { accountName: 'Removed', paypalEmail: '' }
  return {}
}

// The partner-facing mail templates (src/services/email.service.js). email_logs is shared with candidate
// accounts, so only these are purged - an address that is also a candidate's login keeps that history.
const PARTNER_MAIL_TEMPLATES = require('../lib/partnerMailTemplates')
const likeEscape = v => String(v).replace(/[\\%_]/g, '\\$&')

async function purgePartnerLogs(supabase, { partnerId, emails }) {
  const out = { emailLogs: 0, alertLogs: 0, ok: true }
  try {
    const addrs = [...new Set((emails || []).filter(Boolean).flatMap(e => [String(e), String(e).toLowerCase()]))]
    if (addrs.length) {
      const { count, error } = await supabase.from('email_logs').delete({ count: 'exact' })
        .in('to', addrs).in('template', PARTNER_MAIL_TEMPLATES)
      if (error) throw error
      out.emailLogs = count || 0
    }
    // Owner alerts quote "partner: <name> <email>" in the MESSAGE; match on each address (case-insensitively)
    // and on the partner id.
    const needles = [...new Set([...(emails || []).filter(Boolean).map(e => String(e).toLowerCase()), partnerId])]
    for (const needle of needles) {
      const { count, error } = await supabase.from('alert_logs').delete({ count: 'exact' }).ilike('message', `%${likeEscape(needle)}%`)
      if (error) throw error
      out.alertLogs += count || 0
    }
  } catch (err) {
    out.ok = false
    console.error('anonymizePartner: could not clear the mail/alert history of a removed partner:', err.message)
  }
  return out
}

async function adminAnonymizePartner(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const body = anonymizePartnerSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)

  const { data: partner, error: pErr } = await supabase.from('partners').select('id, email, previous_emails, dashboard_token_version').eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  const alreadyRemoved = isRemovedEmail(partner.email)
  // Every address this partner ever had (round 11, bug: only the CURRENT one used to be cleaned from the mail history).
  const allEmails = [...(alreadyRemoved ? [] : [partner.email]), ...(Array.isArray(partner.previous_emails) ? partner.previous_emails : [])].filter(Boolean)

  // Round 11: the balance guard exists to stop the details being wiped before the money is settled. On a record
  // that is ALREADY wiped that reason is gone, and keeping the guard made a late refund credit (or an in-flight sale)
  // a dead end - re-running the removal could not finish its leftover steps. Settle such a balance with a
  // write-off adjustment (now allowed on removed partners); it no longer blocks the cleanup.
  const owed = alreadyRemoved ? 0 : await sumPaged(() => supabase.from('commission_ledger')
    .select('id, commission_amount_cents').eq('partner_id', partnerId).is('payout_id', null), 'commission_amount_cents')
  if (owed !== 0)
    return ctx.json({ success: false, code: 'COMMISSION_OWED',
      message: owed > 0
        ? `This partner is still owed ${owed} cents of commission. Record the payout (or void and re-record it), or write the balance off with a ledger adjustment, before removing their data.`
        : `This partner has an unsettled refund credit of ${-owed} cents. Settle it, or write it off with a ledger adjustment, before removing their data.` }, 409)

  // 1. Applications (approved ones point at the partner; earlier/rejected ones are found by the address).
  const { error: appErr1 } = await supabase.from('partner_applications').delete().eq('partner_id', partnerId)
  if (appErr1) throw appErr1
  for (const addr of allEmails) {
    const exact = String(addr).replace(/[\\%_]/g, '\\$&')
    const { error: appErr2 } = await supabase.from('partner_applications').delete().ilike('email', exact)
    if (appErr2) throw appErr2
  }

  // 2. Codes stop applying (a removed partner must not keep earning).
  const { error: codeErr } = await supabase.from('referral_codes').update({ active: false }).eq('partner_id', partnerId)
  if (codeErr) throw codeErr

  // Round 15 (gap): the code TEXT outlived the erasure, and a code is often a name (ANNA20). Each code is renamed to a
  // neutral placeholder; accounts attributed to it forget the string and the payments' snapshot of it is rewritten. Per code,
  // in that order, so a failure part-way leaves the original text in place for the retry to find.
  const { data: ownCodes, error: ownCodesErr } = await supabase.from('referral_codes').select('id, code').eq('partner_id', partnerId)
  if (ownCodesErr) throw ownCodesErr
  for (const rc of ownCodes || []) {
    if (/^REMOVED-[0-9A-F]{8}$/.test(rc.code)) continue
    const placeholder = `REMOVED-${String(rc.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`
    const { error: uErr } = await supabase.from('users').update({ referred_by_code: null, referred_at: null, referred_sub: null }).eq('referred_by_code', rc.code)
    if (uErr) throw uErr
    const { error: pErr2 } = await supabase.from('payments').update({ referral_code: placeholder }).eq('referral_code_id', rc.id)
    if (pErr2) throw pErr2
    // Round 16: a partner's channel tags (`?sub=`) are their own wording and can name them — forget them with the code text.
    const { error: subPayErr } = await supabase.from('payments').update({ referral_sub: null }).eq('referral_code_id', rc.id).not('referral_sub', 'is', null)
    if (subPayErr) throw subPayErr
    const { error: subLedErr } = await supabase.from('commission_ledger').update({ attribution_sub: null }).eq('referral_code_id', rc.id).not('attribution_sub', 'is', null)
    if (subLedErr) throw subLedErr
    // Round 18: the per-channel click counters carry the same partner-worded tags.
    const { error: subClkErr } = await supabase.from('referral_sub_clicks').delete().eq('code_id', rc.id)
    if (subClkErr) throw subClkErr
    const { error: rnErr } = await supabase.from('referral_codes').update({ code: placeholder }).eq('id', rc.id)
    if (rnErr) throw rnErr
  }

  // Section 4 round 9 (bug): the owed-check above and the code switch-off in step 2 are two separate moments; a
  // checkout that had already resolved the code could convert in between and leave fresh commission on a partner
  // we are about to wipe. Codes are off now, so look once more before anything irreversible happens.
  const owedAfter = alreadyRemoved ? 0 : await sumPaged(() => supabase.from('commission_ledger')
    .select('id, commission_amount_cents').eq('partner_id', partnerId).is('payout_id', null), 'commission_amount_cents')
  if (owedAfter !== 0)
    return ctx.json({ success: false, code: 'COMMISSION_OWED',
      message: 'A sale converted while this was running, so commission is owed again. The partner\u2019s codes are now switched off \u2014 record the payout (or write the balance off), then run the removal again.' }, 409)

  // 3. Past payouts keep amount/date/method; the account they went to is reduced to a masked reference. The
  // free-text notes an admin typed against a payout (names, phone numbers, transfer references) are cleared too —
  // `void_reason` is left, it is the accounting trail for a voided payout.
  const { data: payouts, error: poErr } = await supabase.from('payouts')
    .select('id, payout_method, payout_details_snapshot').eq('partner_id', partnerId)
  if (poErr) throw poErr
  for (const po of payouts || []) {
    const { error: upErr } = await supabase.from('payouts')
      .update({ payout_details_snapshot: maskedPayoutSnapshot(po.payout_method, po.payout_details_snapshot), note: null, internal_note: null }).eq('id', po.id)
    if (upErr) throw upErr
  }

  // Partners round 39 (bug): the acceptance log kept the applicant's email, IP hash and user agent after the erasure. Rows tied to the partner
  // keep only what proves the acceptance (version, source, time); rows logged at application time (email only) are deleted outright.
  // Open code requests quote the partner's free text. Done BEFORE the partner row is wiped: a retry after the wipe no longer knows the old addresses.
  const { error: termsScrubErr } = await supabase.from('partner_terms_acceptances')
    .update({ application_email: null, ip_hash: null, user_agent: null }).eq('partner_id', partnerId)
  if (termsScrubErr) throw termsScrubErr
  for (const addr of allEmails) {
    const exact = String(addr).replace(/[\\%_]/g, '\\$&')
    const { error: termsDelErr } = await supabase.from('partner_terms_acceptances').delete().is('partner_id', null).ilike('application_email', exact)
    if (termsDelErr) throw termsDelErr
  }
  const { error: reqScrubErr } = await supabase.from('partner_code_requests').update({ note: null, wanted_code: null }).eq('partner_id', partnerId)
  if (reqScrubErr) throw reqScrubErr

  // 4. The partner row, last.
  const { error: rowErr } = await supabase.from('partners').update({
    name: 'Removed partner', email: `partner-${partnerId}@${REMOVED_EMAIL_DOMAIN}`, status: 'PAUSED',
    payout_method: null, payout_details: null, payout_details_submitted_at: null,
    tax_country: null, tax_id: null,
    website: null, audience: null, notify_conversions: false, internal_notes: null,
    ...(await payoutTokenFields(cryptoLib.randomToken(32))), ...partnerLinks.rotateDashboardPatch(partner),
    previous_emails: [],
    updated_at: new Date().toISOString()
  }).eq('id', partnerId)
  if (rowErr) throw rowErr

  // Round 8: an adjustment's reason is free text an admin typed about this person; the amount stays (it is a
  // financial record), the words go.
  const { error: adjErr } = await supabase.from('commission_ledger')
    .update({ adjustment_reason: 'Adjustment (details removed)' }).eq('partner_id', partnerId).eq('kind', 'ADJUSTMENT')
  if (adjErr) throw adjErr

  // Round 8 (bug): the removal used to leave the address behind in email_logs (every partner mail we ever sent
  // it) and in alert_logs (owner alerts quote the partner's name, email and payout-target tail) until the 90 /
  // 180-day retention sweep. The sibling erasure flows (deleteAccount, employer-lead removal) purge email_logs;
  // this one did not. BEST EFFORT and the LAST step: the erasure above is what a person is owed, and a failed
  // purge only means the rows age out with the sweep, exactly as before.
  const logs = allEmails.length || !alreadyRemoved
    ? await purgePartnerLogs(supabase, { partnerId, emails: allEmails })
    : { emailLogs: 0, alertLogs: 0, ok: true }

  await logAdminAction(ctx, supabase, 'partner.anonymized', 'partner', partnerId,
    { reason: body.reason, alreadyRemoved, payoutsMasked: (payouts || []).length, logsPurged: logs.ok, emailLogsPurged: logs.emailLogs, alertLogsPurged: logs.alertLogs })
  return ctx.json({ success: true, alreadyRemoved, payoutsMasked: (payouts || []).length, logsPurged: logs.ok,
    message: alreadyRemoved ? 'Already removed \u2014 checked and finished any leftover steps. (A leftover balance on a removed record is cleared with a write-off adjustment.)' : 'Partner data removed.' })
}

// ── Round 8 (feature gap): manual ledger adjustments ───────────────────────
// The ledger could only ever hold a sale and the reversal of a sale. There was no way to claw back commission
// from a fraudulent referral (short of refunding the buyer), to grant a goodwill bonus, or to write off a
// balance that could never be paid - which also blocked erasing the partner (adminAnonymizePartner needs a
// zero balance, and a partner with no payout details can't be paid). An adjustment is a ledger row of kind
// ADJUSTMENT (migration 0069): signed amount, mandatory reason, no payment, no code. Everything that reads
// commission_amount_cents - balances, payout claim, void release, the anonymize check - picks it up unchanged;
// the cycle logic treats it as a credit row (isCreditRow) and it is never held or counted as a conversion.
const MAX_ADJUSTMENT_CENTS = 100000000   // 1,000,000.00 - a typo guard, far under the int4 column limit
const adjustLedgerSchema = z.object({
  amountCents: z.number().int()
    .refine(n => n !== 0, 'The amount cannot be zero.')
    .refine(n => Math.abs(n) <= MAX_ADJUSTMENT_CENTS, 'That amount is larger than the allowed maximum.'),
  reason: z.string().trim().min(3, 'Say why - the partner sees this reason.').max(500),
  notify: z.boolean().optional()
})

async function adminAdjustLedger(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const body = adjustLedgerSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data: partner, error: pErr } = await supabase
    .from('partners').select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  // Section 4 round 11 (bug): a removed partner could not be adjusted, yet a late refund reversal or an in-flight
  // checkout can still leave a non-zero balance on the wiped record, and every other way out of it (a payout
  // needs details, the anonymize check needs zero) was closed too. An adjustment on a removed partner is allowed
  // as a WRITE-OFF: no email (the address is a placeholder), and the reason is stored generically because the
  // erasure already promised no free text about this person remains.
  const removed = isRemovedEmail(partner.email)

  const currency = c.activeCurrency(ctx.env)
  const actor = ctx.get && ctx.get('user')
  const { data: row, error } = await supabase.from('commission_ledger').insert({
    partner_id: partnerId, kind: 'ADJUSTMENT', gross_amount_cents: 0, commission_rate: 0,
    commission_amount_cents: body.amountCents, currency, adjustment_reason: removed ? 'Adjustment (details removed)' : body.reason,
    created_by: actor?.id || null
  }).select('*').single()
  if (error) throw error

  let emailed = false
  if (body.notify !== false && !removed) {
    const dashboardUrl = await partnerLinks.dashboardUrlOf(ctx.env, partner)
    emailed = await emailService.sendPartnerBalanceAdjusted(ctx.env, supabase, partner.email, partner.name,
      body.amountCents, currency, body.reason, dashboardUrl).then(ok => ok === true || ok === undefined).catch(() => false)
  }

  // Amount and ledger id only - the reason lives on the row, where erasure scrubs it.
  await logAdminAction(ctx, supabase, 'partner.ledger_adjusted', 'partner', partnerId,
    { ledgerId: row.id, amountCents: body.amountCents, currency, emailed, ...(removed ? { removedPartnerWriteOff: true } : {}) })
  return ctx.json({ success: true, data: commissionLedgerRowToCamel(row), emailed })
}

// ── Round 8 (feature gap): terms acceptance and re-acceptance ───────────────
// Only an applicant ever recorded terms_accepted_at (applyAsPartner); a partner an admin created directly never
// did, and a version bump had no path at all although the terms page promises an email before a change applies.
// Acceptance here is NOT a gate on payouts (that is a policy call for the owner) - it is recorded, shown to the
// admin, and prompted on the dashboard.
// ── Round 10 (feature gap): partner self-serve "reset my links" ────────────────────────────────────────────────
// Links are bearer credentials that sit in email and browser history. A partner who suspected theirs had leaked had no
// way to kill them — only an admin could rotate. Either token may ask; BOTH links are replaced and the new ones are
// emailed to the address on file ONLY (never returned, so holding an old link never yields a new one). The swap is
// guarded on the presented token still being current, and undone if the email cannot be sent, so a partner is never left
// locked out with no way to learn the new links.
async function resetMyPartnerLinks(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id, name, email, dashboard_token, payout_token_hash')
  if (!partner || isRemovedEmail(partner.email)) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  const newPayout = cryptoLib.randomToken(32)
  const dashPatch = partnerLinks.rotateDashboardPatch(partner)
  const newDashUrl = await partnerLinks.dashboardUrlOf(ctx.env, { id: partner.id, ...dashPatch })
  // Compare-and-swap on what the link holder was resolved from: the link version and the payout hash (and the legacy stored
  // token while a partner still has one), so two resets racing cannot both win.
  let swapQ = supabase.from('partners')
    .update({ ...dashPatch, ...(await payoutTokenFields(newPayout)), updated_at: new Date().toISOString() })
    .eq('id', partner.id).eq('dashboard_token_version', Number(partner.dashboard_token_version) || 0)
    .eq('payout_token_hash', partner.payout_token_hash)
  swapQ = partner.dashboard_token ? swapQ.eq('dashboard_token', partner.dashboard_token) : swapQ.is('dashboard_token', null)
  const { data: swapped, error: swapErr } = await swapQ.select('id').maybeSingle()
  if (swapErr) throw swapErr
  if (!swapped) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)

  const emailed = await emailService.sendPartnerLinksSelfReset(ctx.env, supabase, partner.email, partner.name,
    newDashUrl, `${ctx.env.FRONTEND_URL}/partner/payout-details?token=${newPayout}`).catch(() => false)
  if (!emailed) {
    // Put the old links back (only if nothing else rotated them meanwhile) rather than strand the partner.
    const { error: undoErr } = await supabase.from('partners')
      .update({ dashboard_token: partner.dashboard_token, dashboard_token_version: Number(partner.dashboard_token_version) || 0, payout_token_hash: partner.payout_token_hash })
      .eq('id', partner.id).eq('dashboard_token_version', dashPatch.dashboard_token_version).eq('payout_token_hash', await cryptoLib.sha256(newPayout))
    if (undoErr) console.error('resetMyPartnerLinks undo:', undoErr.message)
    return ctx.json({ success: false, code: 'EMAIL_FAILED',
      message: 'We couldn\u2019t send your new links, so nothing was changed. Please try again in a few minutes.' }, 502)
  }
  try {
    await emailService.sendOwnerAlert(ctx.env, 'A partner reset their own links',
      `partner: ${partner.name} <${partner.email}>\n\nBoth links were rotated from the partner's dashboard and the new ones were emailed to the address on file. No action needed unless this partner did not ask for it.`,
      { dedupeKey: `partner-self-reset:${partner.id}` })
  } catch (_) {}
  return ctx.json({ success: true, message: 'Done — we emailed your new links to the address we have on file. Your old links no longer work.' })
}

// ── Round 10 (feature gap): remember the referral code on the signed-in ACCOUNT ─────────────────────────────────
// body { code: string | null, capturedAt?, sub? }. null/'' clears it (the buyer removed the code on purpose). A code that cannot apply is
// answered { stored: false } rather than an error — the SPA simply keeps what it had.
const attributionSchema = z.object({
  code: z.string().trim().max(100).nullable().optional(),
  capturedAt: z.string().datetime().optional(),   // when the browser first captured the code — keeps the 30-day window honest
  sub: z.string().trim().max(40).nullable().optional().catch(undefined)   // the link's channel tag (&sub=); anything that is not a valid tag is dropped
})
async function setMyReferralAttribution(ctx) {
  const user = ctx.get('user')
  const body = attributionSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const out = await referralService.setUserAttribution(supabase, user, body.code ?? null, body.capturedAt, body.sub ?? null)
  return ctx.json({ success: true, data: out })
}

const acceptTermsSchema = z.object({ version: z.string().trim().max(40).optional() })
// Partners round 38: an append-only trail of every acceptance (the partner row only keeps the LATEST one). Best-effort - a database that has
// not run migration 0115 yet must not stop a partner accepting.
async function logTermsAcceptance(ctx, supabase, { partnerId = null, applicationEmail = null, version, source, acceptedAt }) {
  try {
    let ipHash = null
    try { ipHash = (await cryptoLib.sha256(String(clientIp(ctx) || ''))).slice(0, 32) } catch (_) { ipHash = null }
    const ua = (ctx.req.header && ctx.req.header('user-agent')) || null
    const { error } = await supabase.from('partner_terms_acceptances').insert({
      partner_id: partnerId, application_email: applicationEmail, version, source, accepted_at: acceptedAt,
      ip_hash: ipHash, user_agent: ua ? String(ua).slice(0, 300) : null
    })
    if (error) console.error('logTermsAcceptance:', error.message)
  } catch (err) {
    console.error('logTermsAcceptance unexpected:', err.message)
  }
}
async function acceptPartnerTerms(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id, name, email, terms_version')
  if (!partner || isRemovedEmail(partner.email)) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  // Partners round 38: the click used to record whichever version was current at that moment, not the one on screen. The dashboard now
  // sends the version it displayed; if the terms moved on since, nothing is recorded and the page reloads to show the new text.
  const acceptBody = acceptTermsSchema.safeParse(await (typeof ctx.req.json === 'function' ? ctx.req.json().catch(() => ({})) : {}) || {})
  const shownVersion = acceptBody.success ? acceptBody.data.version : undefined
  if (shownVersion !== undefined && shownVersion !== PARTNER_TERMS_VERSION)
    return ctx.json({ success: false, code: 'TERMS_VERSION_CHANGED', currentTermsVersion: PARTNER_TERMS_VERSION,
      message: 'The partner terms were updated while this page was open. Reload to read the current version, then accept it.' }, 409)
  if (partner.terms_version === PARTNER_TERMS_VERSION)
    return ctx.json({ success: true, alreadyAccepted: true, termsVersion: PARTNER_TERMS_VERSION })
  const acceptedAt = new Date().toISOString()
  const { error } = await supabase.from('partners')
    .update({ terms_accepted_at: acceptedAt, terms_version: PARTNER_TERMS_VERSION }).eq('id', partner.id)
  if (error) throw error
  await logTermsAcceptance(ctx, supabase, { partnerId: partner.id, version: PARTNER_TERMS_VERSION, source: 'dashboard', acceptedAt })
  // Round 10: the read-only dashboard token is enough to record a legal acceptance. The partner is told at the address on
  // file, so an acceptance they did not make is visible to them. Best-effort, after the response.
  runInBackground(ctx, emailService.sendPartnerTermsAccepted(ctx.env, supabase, partner.email, partner.name, PARTNER_TERMS_VERSION).catch(() => false))
  return ctx.json({ success: true, alreadyAccepted: false, termsVersion: PARTNER_TERMS_VERSION, termsAcceptedAt: acceptedAt })
}

// Emails every ACTIVE or PAUSED partner who has not accepted the current version, once each. Capped per run (the mail
// provider throttles) and resumable: terms_notified_version records who has been told, so clicking again only
// sends to the rest and never mails anyone twice for the same version.
const TERMS_NOTICE_BATCH = 40
// `skipIds` (optional): partners whose send already FAILED in an earlier run of this batch session. Failed partners are not
// marked notified, so without it they stayed at the head of the created_at-ordered batch and a run of 40 persistently
// failing addresses (bounced / suppressed) would block everyone behind them forever. The response returns `failedIds`
// so the admin page can hand them back; a fresh page load starts over.
const termsNoticeSchema = z.object({ skipIds: z.array(z.string().uuid()).max(500).optional() })
async function adminSendTermsNotice(ctx) {
  const supabase = getSupabase(ctx.env)
  const version = PARTNER_TERMS_VERSION
  const body = termsNoticeSchema.parse(await ctx.req.json().catch(() => ({})))
  const skipIds = body.skipIds || []
  let q = supabase.from('partners')
    .select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`, { count: 'exact' })
    // PAUSED partners are told too: the terms page promises an email before a change, and they may be reactivated.
    .in('status', ['ACTIVE', 'PAUSED'])
    // Erased partners are left PAUSED with a placeholder address: they can never be mailed or marked notified, so they
    // must not count towards `remaining` or sit at the head of the batch (round 19).
    .not('email', 'ilike', `%@${REMOVED_EMAIL_DOMAIN}`)
    .neq('id', WELCOME_PARTNER_ID)
    .or(`terms_version.is.null,terms_version.neq.${version}`)
    .or(`terms_notified_version.is.null,terms_notified_version.neq.${version}`)
  if (skipIds.length) q = q.not('id', 'in', `(${skipIds.join(',')})`)
  const { data, count, error } = await q.order('created_at', { ascending: true }).limit(TERMS_NOTICE_BATCH)
  if (error) throw error
  const targets = (data || []).filter(p => !isRemovedEmail(p.email))
  let sent = 0
  const failedIds = []
  for (const p of targets) {
    const ok = await emailService.sendPartnerTermsUpdate(ctx.env, supabase, p.email, p.name, version,
      `${ctx.env.FRONTEND_URL}/partner/terms`, await partnerLinks.dashboardUrlOf(ctx.env, p))
      .then(r => r === true || r === undefined).catch(() => false)
    if (!ok) { failedIds.push(p.id); continue }
    const { error: upErr } = await supabase.from('partners').update({ terms_notified_version: version }).eq('id', p.id)
    if (upErr) { failedIds.push(p.id); continue }
    sent += 1
  }
  const failed = failedIds.length
  const remaining = Math.max(0, (count ?? targets.length) - sent - failed)
  await logAdminAction(ctx, supabase, 'partner.terms_notice_sent', 'partner', null, { version, sent, failed, remaining })
  return ctx.json({ success: true, version, sent, failed, failedIds, remaining })
}

// ── Round 20 (feature gap): the whole commission ledger, across partners ───────────────────────────────────────────
// Per-partner ledger CSVs and the payouts log existed; month-end reconciliation against Paystack and the books needed every sale,
// refund and adjustment in one file. Read-only and paged (the admin page walks it into a CSV). A date-only `to` means through the
// end of that day, like the payouts log.
async function adminListLedger(ctx) {
  const supabase = getSupabase(ctx.env)
  const { limit, offset } = pageParams(ctx)
  let query = supabase.from('commission_ledger')
    .select('id, created_at, partner_id, kind, reverses_ledger_id, reversal_reason, adjustment_reason, gross_amount_cents, commission_rate, commission_amount_cents, currency, payout_id, attribution_sub, partners(name, email), referral_codes(code), payments(paystack_ref), payouts(paid_at, voided_at)', { count: 'exact' })
  const partnerId = ctx.req.query('partnerId')
  if (partnerId && UUID_RE.test(partnerId)) query = query.eq('partner_id', partnerId)
  else if (ctx.req.query('includeSystem') !== 'true') query = query.neq('partner_id', WELCOME_PARTNER_ID)   // round 29: 0-cent welcome-code rows
  const from = ctx.req.query('from'), to = ctx.req.query('to')
  if (from && !Number.isNaN(Date.parse(from))) query = query.gte('created_at', new Date(from).toISOString())
  if (to && !Number.isNaN(Date.parse(to))) {
    const toMs = /^\d{4}-\d{2}-\d{2}$/.test(to.trim()) ? Date.parse(to) + 86400000 - 1 : Date.parse(to)
    query = query.lte('created_at', new Date(toMs).toISOString())
  }
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, currency: c.activeCurrency(ctx.env), data: (data || []).map(r => ({
    id: r.id, createdAt: r.created_at, partnerId: r.partner_id,
    partnerName: r.partners?.name ?? null, partnerEmail: r.partners?.email ?? null, code: r.referral_codes?.code ?? null,
    type: r.kind === 'ADJUSTMENT' ? 'ADJUSTMENT' : r.reverses_ledger_id ? 'REVERSAL' : 'SALE',
    paymentRef: r.payments?.paystack_ref ?? null,
    grossAmountCents: r.gross_amount_cents, commissionRate: r.commission_rate == null ? null : Number(r.commission_rate),
    commissionAmountCents: r.commission_amount_cents, currency: r.currency ?? c.activeCurrency(ctx.env),
    // A voided payout released its rows, so a row only ever points at a live one — the check is belt and braces.
    paid: !!r.payout_id && !r.payouts?.voided_at, paidAt: r.payouts?.voided_at ? null : (r.payouts?.paid_at ?? null),
    reason: r.kind === 'ADJUSTMENT' ? (r.adjustment_reason ?? null) : (r.reversal_reason ?? null), sub: r.attribution_sub ?? null
  })) })
}

// ── Round 18 (feature gap): reject ONE sale ─────────────────────────────────
// Until now a single fraudulent or disputed-by-hand sale could only be clawed back with an unlinked adjustment, or by
// refunding the buyer. This reverses that sale's commission in the ledger exactly the way a refund does (a negative row
// pointing at the original, the usage slot released) without touching the buyer's payment. The admin's wording stays in
// the audit log; the partner sees a fixed reason, so internal notes never reach them.
// Round 27: partners created before migration 0107 still have their dashboard link STORED in the database. Converting one means
// rotating it (the stored value cannot be turned into the derived form without changing the link), so the partner is emailed the
// new link in the same step; if that email fails the old link is restored and the partner is reported back as failed. Batched
// like the terms notice: run it until `remaining` is 0.
const CONVERT_BATCH = 25
// Round 33: like the terms notice, the caller passes the ids that failed earlier in its session so a few permanently failing addresses
// (bounced / suppressed) cannot hold the front of every batch and block everyone behind them.
const convertLinksSchema = z.object({ skipIds: z.array(z.string().uuid()).max(500).optional() })
async function adminConvertLegacyDashboardLinks(ctx) {
  const supabase = getSupabase(ctx.env)
  const convertBody = convertLinksSchema.parse(await (typeof ctx.req.json === 'function' ? ctx.req.json().catch(() => ({})) : {}) || {})
  const convertSkip = convertBody.skipIds || []
  let convertQ = supabase.from('partners')
    .select('id, name, email, dashboard_token, dashboard_token_version', { count: 'exact' })
    .not('dashboard_token', 'is', null)
    .not('email', 'ilike', `%@${REMOVED_EMAIL_DOMAIN}`)
    .neq('id', WELCOME_PARTNER_ID)
  if (convertSkip.length) convertQ = convertQ.not('id', 'in', `(${convertSkip.join(',')})`)
  const { data, count, error } = await convertQ.order('created_at', { ascending: true }).limit(CONVERT_BATCH)
  if (error) throw error
  let converted = 0
  const failedIds = []
  for (const p of (data || []).filter(x => !isRemovedEmail(x.email))) {
    const patch = partnerLinks.rotateDashboardPatch(p)
    const { data: swapped, error: upErr } = await supabase.from('partners')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', p.id).eq('dashboard_token', p.dashboard_token).select('id').maybeSingle()
    if (upErr || !swapped) { failedIds.push(p.id); continue }
    const url = await partnerLinks.dashboardUrlOf(ctx.env, { id: p.id, ...patch })
    const ok = await emailService.sendPartnerDashboardLinkRegenerated(ctx.env, supabase, p.email, p.name, url)
      .then(r => r === true || r === undefined).catch(() => false)
    if (ok) { converted += 1; continue }
    failedIds.push(p.id)
    const { error: undoErr } = await supabase.from('partners')
      .update({ dashboard_token: p.dashboard_token, dashboard_token_version: Number(p.dashboard_token_version) || 0 })
      .eq('id', p.id).eq('dashboard_token_version', patch.dashboard_token_version).is('dashboard_token', null)
    if (undoErr) console.error('convertLegacyDashboardLinks undo:', undoErr.message)
  }
  await logAdminAction(ctx, supabase, 'partner.dashboard_links_converted', 'partner', null, { converted, failed: failedIds.length })
  return ctx.json({ success: true, converted, failed: failedIds.length, failedIds,
    remaining: Math.max(0, (count || 0) - converted) })
}

// Round 27 (gap): the full payout destination, on demand. Step-up gated at the route and written to the audit log, so reading a
// partner's account number leaves the same trace as exporting it.
async function adminRevealPayoutDetails(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('partners')
    .select('id, email, payout_method, payout_details, tax_country, tax_id, payouts(id, payout_method, payout_details_snapshot)')
    .eq('id', partnerId).maybeSingle()
  if (error) throw error
  if (!row) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  if (isRemovedEmail(row.email)) return partnerRemovedResponse(ctx)
  ctx.header('Cache-Control', 'no-store')
  // Fail CLOSED: the audit entry is written first, and if it cannot be written nothing is revealed (logAdminAction swallows its
  // own failures, which is right for ordinary actions but wrong for a read of account numbers: no trace, no secrets).
  const actor = ctx.get && ctx.get('user')
  const { error: auditErr } = await supabase.from('admin_audit_log').insert({
    actor_id: actor?.id || null, action: 'partner.details_viewed', target_type: 'partner', target_id: String(partnerId), detail: { method: row.payout_method || null }
  })
  if (auditErr) {
    console.error('admin_audit_log insert failed (partner.details_viewed):', auditErr.message)
    return ctx.json({ success: false, message: 'Could not record this access in the audit log, so the details were not shown. Try again.' }, 503)
  }
  const snapshots = {}
  for (const po of row.payouts || []) snapshots[po.id] = po.payout_details_snapshot || {}
  return ctx.json({ success: true, data: {
    payoutMethod: row.payout_method || null, payoutDetails: row.payout_details || null,
    taxCountry: row.tax_country ?? null, taxId: (await fieldCrypto.openTaxId(ctx.env, row.tax_id)) || null, snapshots
  } })
}

// Round 27 (gap): a sale credited to the wrong partner (the buyer used one link but typed another code, a code was shared, a
// partner was merged) could only be fixed by reversing it and hand-writing an adjustment for the right partner. This moves ONE
// unpaid, un-reversed sale to another partner's code atomically (ledger row, payment row, both codes' usage counters) at the
// TARGET partner's current rate. Paid sales are refused: reverse them and adjust instead, so the settled payout stays true.
const reattributeSaleSchema = z.object({
  toCode: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters).').max(300)
})
async function adminReattributeSale(ctx) {
  const body = reattributeSaleSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('commission_ledger')
    .select('id, partner_id, referral_code_id, kind, reverses_ledger_id, payment_id, gross_amount_cents, commission_amount_cents, payout_id')
    .eq('id', ctx.req.param('ledgerId')).eq('partner_id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  if (!row) return ctx.json({ success: false, message: 'Sale not found for this partner.' }, 404)
  if (row.kind === 'ADJUSTMENT' || row.reverses_ledger_id || !row.payment_id)
    return ctx.json({ success: false, message: 'Only a sale can be moved.' }, 400)
  if (row.payout_id)
    return ctx.json({ success: false, code: 'ALREADY_PAID', message: 'This sale is already part of a payout. Reverse it and add an adjustment for the right partner instead.' }, 409)

  const target = await referralService.lookupCode(supabase, body.toCode)
  if (!target || !target.partners) return ctx.json({ success: false, message: 'That code does not exist.' }, 404)
  if (isRemovedEmail(target.partners.email)) return partnerRemovedResponse(ctx)
  // Round 29: a personal welcome code (owned by the 0% system partner) or a code that is switched off / expired cannot receive a sale.
  if (isSystemPartnerId(target.partner_id) || target.user_id)
    return ctx.json({ success: false, code: 'PERSONAL_CODE', message: 'That is a personal welcome code; a sale cannot be credited to it.' }, 409)
  if (target.active === false || (target.expires_at && Date.parse(target.expires_at) < Date.now()))
    return ctx.json({ success: false, code: 'CODE_INACTIVE', message: 'That code is switched off or expired. Re-activate it first, or credit a different code.' }, 409)
  if (target.partners.status !== 'ACTIVE')
    return ctx.json({ success: false, message: 'That code belongs to a partner who is not active.' }, 409)
  if (target.id === row.referral_code_id)
    return ctx.json({ success: false, message: 'The sale already belongs to that code.' }, 409)
  // Partners round 38: a partial-refund adjustment stays with the partner it was charged to. Moving the sale would leave that deduction
  // behind while the new partner earned the whole commission.
  {
    const { data: partials, error: partialsErr } = await supabase.from('commission_ledger').select('id').eq('adjusts_ledger_id', row.id).limit(1)
    if (partialsErr) throw partialsErr
    if ((partials || []).length > 0)
      return ctx.json({ success: false, code: 'HAS_PARTIAL_ADJUSTMENT', message: 'Part of this sale\u2019s commission was already taken back (a partial refund). Reverse the sale in full, or leave it where it is.' }, 409)
  }
  const rate = Number(target.partners.commission_rate)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1)
    return ctx.json({ success: false, message: 'That partner has no valid commission rate.' }, 409)
  const commissionCents = Math.round(row.gross_amount_cents * rate)

  // Round 28: the buyer must not be the target partner (or an address they used before) - the same self-referral rule checkout and
  // recordConversion apply, which a move would otherwise sidestep. A buyer we cannot resolve (no account email) is not blocked.
  const { data: pay, error: payErr } = await supabase.from('payments').select('user_id, currency').eq('id', row.payment_id).maybeSingle()
  if (payErr) throw payErr
  let buyerEmail = null
  if (pay?.user_id) {
    const { data: buyer, error: buyerErr } = await supabase.from('users').select('email').eq('id', pay.user_id).maybeSingle()
    if (buyerErr) throw buyerErr
    buyerEmail = buyer?.email || null
  }
  if (referralService.isSelfReferral(target, buyerEmail))
    return ctx.json({ success: false, code: 'SELF_REFERRAL', message: 'The buyer is that partner (or used their email), so the sale cannot be credited to them.' }, 409)

  const { data: outcome, error: rpcErr } = await supabase.rpc('reattribute_sale', {
    p_ledger_id: row.id, p_to_code_id: target.id, p_to_partner_id: target.partner_id, p_rate: rate, p_commission_cents: commissionCents
  })
  if (rpcErr) throw rpcErr
  const refused = {
    already_paid:     [409, 'This sale is already part of a payout. Reverse it and add an adjustment instead.'],
    already_reversed: [409, 'This sale was already reversed.'],
    has_adjustments:  [409, 'This sale has an adjustment or a partial refund against it, so it cannot be moved. Reverse it and credit the right partner with an adjustment instead.'],
    not_a_sale:       [400, 'Only a sale can be moved.'],
    same_code:        [409, 'The sale already belongs to that code.'],
    target_not_found: [404, 'That code does not exist.'],
    target_exhausted: [409, 'That code has reached its usage limit. Raise the limit first, or credit a different code.'],
    not_found:        [404, 'Sale not found for this partner.']
  }
  if (outcome !== 'ok') {
    const [status, message] = refused[outcome] || [409, 'The sale could not be moved.']
    return ctx.json({ success: false, code: String(outcome || 'REFUSED').toUpperCase(), message }, status)
  }
  await logAdminAction(ctx, supabase, 'partner.sale_reattributed', 'partner', row.partner_id,
    { ledgerId: row.id, paymentId: row.payment_id, fromCodeId: row.referral_code_id, toCodeId: target.id, toPartnerId: target.partner_id,
      rate, commissionCents, reason: body.reason })

  // Round 28: a balance must never change silently. Both partners are told - the one who lost the sale (it also drops off their
  // dashboard) and the one who gained it. The admin's reason stays internal: it may name the other partner or the buyer.
  // Best-effort and awaited, so a mail failure is reported but never undoes the (already committed) move.
  const emailed = { from: false, to: false }
  try {
    const { data: people } = await supabase.from('partners').select('id, name, email').in('id', [row.partner_id, target.partner_id])
    const byId = new Map((people || []).map(p => [p.id, p]))
    const currency = pay?.currency || c.activeCurrency(ctx.env)
    const emailService = require('../services/email.service')
    const from = byId.get(row.partner_id), to = byId.get(target.partner_id)
    const [a, b] = await Promise.all([
      from?.email ? emailService.sendPartnerSaleMoved(ctx.env, supabase, from.email, from.name, 'away', row.commission_amount_cents, currency).catch(() => false) : false,
      to?.email ? emailService.sendPartnerSaleMoved(ctx.env, supabase, to.email, to.name, 'to', commissionCents, currency).catch(() => false) : false
    ])
    emailed.from = a === true || a === undefined
    emailed.to = b === true || b === undefined
  } catch (err) { console.error('adminReattributeSale notify:', err.message) }
  return ctx.json({ success: true, emailed, data: { toPartnerId: target.partner_id, toCodeId: target.id, commissionCents } })
}

// Partners round 38 (feature gap): `refundCents` takes back the commission on PART of the sale (a goodwill partial refund). Only a full refund
// ever reversed commission automatically; a partial one was alerted and left to a hand-typed adjustment that nothing tied to the sale.
// Without it the whole sale is reversed, exactly as before.
const reverseSaleSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters).').max(300),
  refundCents: z.number().int().positive().max(MAX_PAYOUT_CENTS).optional()
})
async function adminReverseSale(ctx) {
  const ledgerId = ctx.req.param('ledgerId')
  const body = reverseSaleSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const { data: row, error } = await supabase.from('commission_ledger')
    .select('id, payment_id, partner_id, kind, reverses_ledger_id, commission_amount_cents, commission_rate, gross_amount_cents, currency, payout_id')
    .eq('id', ledgerId).eq('partner_id', ctx.req.param('id')).maybeSingle()
  if (error) throw error
  if (!row) return ctx.json({ success: false, message: 'Sale not found for this partner.' }, 404)
  if (row.kind === 'ADJUSTMENT' || row.reverses_ledger_id || !row.payment_id)
    return ctx.json({ success: false, message: 'Only a sale can be reversed. Use an adjustment for anything else.' }, 400)

  if (body.refundCents !== undefined) {
    if (body.refundCents > row.gross_amount_cents)
      return ctx.json({ success: false, code: 'REFUND_EXCEEDS_SALE', message: `The refund (${body.refundCents}) is more than the sale (${row.gross_amount_cents}).` }, 400)
    const takeBack = Math.round(body.refundCents * Number(row.commission_rate))
    if (!Number.isFinite(takeBack) || takeBack <= 0)
      return ctx.json({ success: false, code: 'NOTHING_TO_REVERSE', message: 'That refund is too small to change the commission.' }, 400)
    const actor = ctx.get && ctx.get('user')
    const { data: adj, error: adjErr } = await supabase.rpc('adjust_sale_commission', {
      p_ledger_id: row.id, p_amount_cents: takeBack,
      p_reason: `Partial refund of ${(body.refundCents / 100).toFixed(2)} ${row.currency || c.activeCurrency(ctx.env)} - commission reduced`,
      p_created_by: actor?.id || null
    })
    if (adjErr) throw adjErr
    const refusals = {
      not_found:        [404, 'Sale not found for this partner.'],
      not_a_sale:       [400, 'Only a sale can be adjusted.'],
      already_reversed: [409, 'This sale was already reversed in full.'],
      exceeds:          [409, `That would take back more than this sale still earns (${adj?.remaining_cents ?? 0} cents left).`]
    }
    if (!adj || adj.status !== 'ok') {
      const [status, message] = refusals[adj?.status] || [409, 'The adjustment could not be recorded.']
      return ctx.json({ success: false, code: String(adj?.status || 'REFUSED').toUpperCase(), message }, status)
    }
    await logAdminAction(ctx, supabase, 'partner.sale_partially_reversed', 'partner', row.partner_id,
      { ledgerId: row.id, paymentId: row.payment_id, refundCents: body.refundCents, commissionCents: takeBack, remainingCents: adj.remaining_cents, reason: body.reason })
    let partialEmailed = false
    try {
      const { data: partner } = await supabase.from('partners').select(`name, email, ${partnerLinks.DASHBOARD_LINK_COLUMNS}`).eq('id', row.partner_id).maybeSingle()
      if (partner?.email && !isRemovedEmail(partner.email))
        partialEmailed = await emailService.sendPartnerBalanceAdjusted(ctx.env, supabase, partner.email, partner.name, -takeBack,
          row.currency || c.activeCurrency(ctx.env), adj.row.adjustment_reason, await partnerLinks.dashboardUrlOf(ctx.env, partner))
          .then(ok => ok === true || ok === undefined).catch(() => false)
    } catch (err) { console.error('adminReverseSale partial notify:', err.message) }
    return ctx.json({ success: true, partial: true, commissionCents: -takeBack, remainingCents: adj.remaining_cents, emailed: partialEmailed })
  }

  const { reverseCommission } = require('../services/fulfillment.service')
  const out = await reverseCommission(supabase, row.payment_id, 'ADMIN_REVERSED')
  if (!out.reversed)
    return ctx.json({ success: false, message: out.reason === 'already-reversed' ? 'This sale was already reversed.' : 'Nothing to reverse for this sale.' }, 409)

  await logAdminAction(ctx, supabase, 'partner.sale_reversed', 'partner', row.partner_id,
    { ledgerId: row.id, paymentId: row.payment_id, commissionCents: out.commissionCents, alreadyPaidOut: out.alreadyPaidOut, reason: body.reason })
  let emailed = false
  try {
    emailed = (await require('../services/referral.service').notifyPartnerReversal(ctx.env, supabase, row.partner_id, out.commissionCents, out.currency)) === true
  } catch (err) { console.error('adminReverseSale notify:', err.message) }
  return ctx.json({ success: true, alreadyPaidOut: out.alreadyPaidOut, commissionCents: out.commissionCents, emailed })
}

// ── Round 18 (feature gap): paid sales that carry a code but have no commission row ──────────────────────────────
// recordConversion failures are retried by the sweeps and announced by an owner alert, but nothing let an admin SEE what
// was still missing. Read-only: a successful payment that used a partner code, older than 15 minutes (the normal path
// finishes in seconds), with no commission row. Recovery is the existing POST /payments/:reference/reconcile.
const UNRECORDED_PAGE = 500, UNRECORDED_MAX_PAGES = 4
async function adminListUnrecordedCommissions(ctx) {
  const supabase = getSupabase(ctx.env)
  const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  const settleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString()
  // Paged (round 19): a single 500-row read hid everything older while the screen said "Nothing missing".
  const pays = []
  let truncated = false
  for (let page = 0; page < UNRECORDED_MAX_PAGES; page += 1) {
    const { data, error } = await supabase.from('payments')
      .select('id, paystack_ref, amount_cents, currency, created_at, scan_id, referral_code_id, referral_codes(code, partners(id, name, email))')
      .eq('status', 'SUCCESS').not('referral_code_id', 'is', null)
      .gte('created_at', since).lte('created_at', settleBefore)
      .order('created_at', { ascending: false }).order('id', { ascending: true })
      .range(page * UNRECORDED_PAGE, (page + 1) * UNRECORDED_PAGE - 1)
    if (error) throw error
    pays.push(...(data || []))
    if (!data || data.length < UNRECORDED_PAGE) break
    if (page === UNRECORDED_MAX_PAGES - 1) truncated = true
  }
  const ids = pays.map(p => p.id)
  const recorded = new Set()
  for (let i = 0; i < ids.length; i += 100) {
    const { data: led, error: lErr } = await supabase.from('commission_ledger')
      .select('payment_id').in('payment_id', ids.slice(i, i + 100)).is('reverses_ledger_id', null)
    if (lErr) throw lErr
    for (const l of led || []) recorded.add(l.payment_id)
  }
  let candidates = pays.filter(p => !recorded.has(p.id) && !isRemovedEmail(p.referral_codes?.partners?.email))

  // Round 19 (bug): reconcile deliberately records NO commission for a payment with no scan, a missing scan, a deleted
  // account or a DUPLICATE (another payment owns the scan). Those have no commission row by design, so listing them
  // gave an endless "missing" row whose Retry can never succeed. Only payments that could earn one stay.
  if (candidates.length) {
    const scanIds = [...new Set(candidates.map(p => p.scan_id).filter(Boolean))]
    const scans = new Map()
    for (let i = 0; i < scanIds.length; i += 100) {
      const { data, error } = await supabase.from('scans').select('id, user_id, fix_payment_id').in('id', scanIds.slice(i, i + 100))
      if (error) throw error
      for (const sc of data || []) scans.set(sc.id, sc)
    }
    const userIds = [...new Set([...scans.values()].map(sc => sc.user_id).filter(Boolean))]
    const gone = new Set(), known = new Set()
    for (let i = 0; i < userIds.length; i += 100) {
      const { data, error } = await supabase.from('users').select('id, deleted_at').in('id', userIds.slice(i, i + 100))
      if (error) throw error
      for (const u of data || []) { known.add(u.id); if (u.deleted_at) gone.add(u.id) }
    }
    candidates = candidates.filter(p => {
      const sc = scans.get(p.scan_id)
      if (!sc) return false
      if (sc.fix_payment_id && sc.fix_payment_id !== p.id) return false
      if (sc.user_id && (!known.has(sc.user_id) || gone.has(sc.user_id))) return false
      return true
    })
  }
  const missing = candidates.slice(0, 100).map(p => ({
    paymentId: p.id, reference: p.paystack_ref, amountCents: p.amount_cents, currency: p.currency, paidAt: p.created_at,
    code: p.referral_codes?.code || null, partnerId: p.referral_codes?.partners?.id || null,
    partnerName: p.referral_codes?.partners?.name || null,
  }))
  return ctx.json({ success: true, data: missing, checked: ids.length, truncated })
}

// ── Partners round 38: partner-side statement, code requests, and the admin tax summary ────────────────────────────────

const STATEMENT_YEAR_MIN = 2024
function statementYearOf(ctx) {
  const now = new Date().getUTCFullYear()
  const asked = Number(ctx.req.query('year'))
  return Number.isInteger(asked) && asked >= STATEMENT_YEAR_MIN && asked <= now ? asked : now
}
// The ledger rows of one UTC calendar year folded into twelve months. Sales and reversals are kept apart so a refund reads as a refund.
// Money is folded for ONE currency at a time (the caller filters the rows): a partner's ledger can span more than one after the
// platform currency was changed, and cents of different currencies must never be added together.
function foldStatementMonths(rows, year) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, sales: 0, grossCents: 0, commissionCents: 0, reversalCents: 0, adjustmentCents: 0, netCents: 0 }))
  for (const r of rows) {
    const at = new Date(r.created_at)
    if (Number.isNaN(at.getTime()) || at.getUTCFullYear() !== year) continue
    const m = months[at.getUTCMonth()]
    const cents = Number(r.commission_amount_cents) || 0
    if (r.kind === 'ADJUSTMENT') m.adjustmentCents += cents
    else if (r.reverses_ledger_id) m.reversalCents += cents
    else { m.sales += 1; m.grossCents += Number(r.gross_amount_cents) || 0; m.commissionCents += cents }
    m.netCents += cents
  }
  return months
}
// One statement block per currency the partner has earned or been paid in that year. The platform currency always comes first (and is
// present even when empty), so the response keeps its old single-currency shape for the common case.
function buildStatementCurrencies(ledger, payouts, year, activeCurrency) {
  const curOf = v => String(v || activeCurrency).toUpperCase()
  const active = String(activeCurrency).toUpperCase()
  const seen = new Set([active])
  for (const r of ledger) {
    const at = new Date(r.created_at)
    if (!Number.isNaN(at.getTime()) && at.getUTCFullYear() === year) seen.add(curOf(r.currency))
  }
  for (const p of payouts) seen.add(curOf(p.currency))
  const order = [active, ...[...seen].filter(cu => cu !== active).sort()]
  return order.map(currency => {
    const months = foldStatementMonths(ledger.filter(r => curOf(r.currency) === currency), year)
    const paid = payouts.filter(p => curOf(p.currency) === currency)
    return {
      currency, months,
      earnedCents: months.reduce((sum, m) => sum + m.netCents, 0),
      paidCents: paid.reduce((sum, p) => sum + (Number(p.amount_cents) || 0), 0),
      payoutCount: paid.length
    }
  })
}
async function getPartnerStatement(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id, name, email, tax_country, tax_id')
  if (!partner || isRemovedEmail(partner.email)) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  const year = statementYearOf(ctx)
  const [ledger, payoutsRes] = await Promise.all([
    loadLedgerForPartner(supabase, partner.id, 'id, kind, reverses_ledger_id, gross_amount_cents, commission_amount_cents, currency, created_at'),
    supabase.from('payouts').select('amount_cents, currency, paid_at, voided_at').eq('partner_id', partner.id)
      .is('voided_at', null).gte('paid_at', `${year}-01-01T00:00:00.000Z`).lt('paid_at', `${year + 1}-01-01T00:00:00.000Z`).order('paid_at', { ascending: true })
  ])
  if (payoutsRes.error) throw payoutsRes.error
  const activeCurrency = c.activeCurrency(ctx.env)
  const currencies = buildStatementCurrencies(ledger, payoutsRes.data || [], year, activeCurrency)
  const main = currencies[0]   // the platform currency
  return ctx.json({ success: true, data: {
    year, currency: activeCurrency, name: partner.name,
    // The platform currency's figures keep the original top-level fields; any other currency is in `currencies`.
    months: main.months, earnedCents: main.earnedCents, paidCents: main.paidCents, payoutCount: main.payoutCount,
    currencies,
    taxCountry: partner.tax_country ?? null,
    taxIdOnFile: !!partner.tax_id,
    // Statement years the partner can ask for: from the first year they have any ledger row or payout.
    firstYear: ledger.reduce((min, r) => Math.min(min, new Date(r.created_at).getUTCFullYear() || min), new Date().getUTCFullYear())
  } })
}

// "I'd like a code of my own" - until now the dashboard said "ask us" and gave no way to. This tells the owner who wants what; it creates
// nothing (a code carries prices the owner sets), so there is nothing here to abuse beyond one email per partner per hour.
const CODE_REQUEST_RESEND_MS = 7 * 24 * 3600 * 1000
const requestCodeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,50}$/, 'Use 2\u201350 letters, digits, - or _.').optional().or(z.literal('').transform(() => undefined)),
  note: z.string().trim().max(300).optional()
})
async function requestPartnerCode(ctx) {
  noStore(ctx)
  const token = partnerTokenOf(ctx)
  if (!token) return ctx.json({ success: false, message: 'Missing token.' }, 400)
  const body = requestCodeSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const { partner } = await findPartnerByAnyToken(ctx.env, supabase, token, 'id, name, email, status')
  if (!partner || isRemovedEmail(partner.email)) return ctx.json({ success: false, message: 'Invalid or expired link.' }, 404)
  if (partner.status !== 'ACTIVE')
    return ctx.json({ success: false, code: 'PARTNER_NOT_ACTIVE', message: 'Your partner account is not active, so new codes cannot be set up right now.' }, 409)
  // Partners round 39 (bug): the request used to exist only as an owner alert email, and the partner was told "received" and locked out for an
  // hour even when that alert failed to send. It is now a row (migration 0116) the admin panel lists; the alert is only a nudge. One OPEN
  // request per partner; an untouched one older than a week may be re-sent (it bumps the request and nudges the owner again).
  if (body.code) {
    const taken = await referralService.lookupCode(supabase, body.code)
    if (taken) return ctx.json({ success: false, code: 'CODE_TAKEN', message: 'That code is already taken - try another.' }, 409)
  }
  const ALREADY = { success: true, alreadyRequested: true, message: 'We already have your request. We will be in touch at the address on file.' }
  const { data: open, error: openErr } = await supabase.from('partner_code_requests')
    .select('id, created_at').eq('partner_id', partner.id).eq('status', 'OPEN').maybeSingle()
  if (openErr) throw openErr
  if (open && Date.now() - Date.parse(open.created_at) < CODE_REQUEST_RESEND_MS) return ctx.json(ALREADY)
  if (open) {
    const { error } = await supabase.from('partner_code_requests')
      .update({ wanted_code: body.code || null, note: body.note || null, created_at: new Date().toISOString() }).eq('id', open.id).eq('status', 'OPEN')
    if (error) throw error
  } else {
    const { error } = await supabase.from('partner_code_requests')
      .insert({ partner_id: partner.id, wanted_code: body.code || null, note: body.note || null })
    // A second tab won the race: the unique open-request index says it is already in.
    if (error && error.code === '23505') return ctx.json(ALREADY)
    if (error) throw error
  }
  await emailService.sendOwnerAlert(ctx.env, 'Partner asked for a new referral code',
    `partner: ${partner.name} <${partner.email}>\nwanted code: ${body.code || '(no preference)'}\nnote: ${body.note || '-'}\n\nIt is also listed under Admin -> Partners -> Code requests. Create the code under (partner) -> Referral codes.`,
    { dedupeKey: partner.id }).catch(() => {})
  return ctx.json({ success: true, message: 'Thanks - we have your request and will email you when the code is ready.' })
}

// Admin: the open (or answered) requests for a code of one's own. Declared before '/:id' in the routes.
const CODE_REQUEST_STATUSES = ['OPEN', 'DONE', 'DISMISSED']
async function adminListCodeRequests(ctx) {
  const status = CODE_REQUEST_STATUSES.includes(ctx.req.query('status')) ? ctx.req.query('status') : 'OPEN'
  const supabase = getSupabase(ctx.env)
  const { limit, offset } = pageParams(ctx)
  const { data, error, count } = await supabase.from('partner_code_requests')
    .select('id, partner_id, wanted_code, note, status, created_at, resolved_at, partners(name, email)', { count: 'exact' })
    .eq('status', status).order('created_at', { ascending: false }).order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return ctx.json({ success: true, total: count ?? null, data: (data || []).map(r => ({
    id: r.id, partnerId: r.partner_id, partnerName: r.partners?.name ?? null, partnerEmail: r.partners?.email ?? null,
    wantedCode: r.wanted_code ?? null, note: r.note ?? null, status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at ?? null
  })) })
}
const resolveCodeRequestSchema = z.object({ status: z.enum(['DONE', 'DISMISSED']) })
async function adminResolveCodeRequest(ctx) {
  const id = ctx.req.param('id')
  const body = resolveCodeRequestSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase.from('partner_code_requests')
    .update({ status: body.status, resolved_at: new Date().toISOString() }).eq('id', id).eq('status', 'OPEN').select('id, partner_id').maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'That request was not found or was already answered.' }, 404)
  await logAdminAction(ctx, supabase, 'partner.code_request_resolved', 'partner', data.partner_id, { requestId: id, status: body.status })
  return ctx.json({ success: true })
}

// Admin: what each partner was PAID in a calendar year, with the tax details collected for it - the figures a payer needs at year end.
// Step-up protected like every other place a full tax ID is shown.
const TAX_SUMMARY_MAX_PAYOUT_PAGES = 100
// Partners round 40: the acceptance trail was written on every acceptance and never readable. This is the admin view of it for one
// partner: acceptances recorded against the partner plus the ones logged under their email when they applied (those carry no partner id).
async function adminListTermsAcceptances(ctx) {
  const partnerId = ctx.req.param('id')
  if (isSystemPartnerId(partnerId)) return systemPartnerResponse(ctx)
  const supabase = getSupabase(ctx.env)
  const { data: partner, error: pErr } = await supabase.from('partners').select('id, email').eq('id', partnerId).maybeSingle()
  if (pErr) throw pErr
  if (!partner) return ctx.json({ success: false, message: 'Partner not found.' }, 404)
  const cols = 'id, version, source, accepted_at, ip_hash, user_agent'
  const { data: own, error: ownErr } = await supabase.from('partner_terms_acceptances').select(cols).eq('partner_id', partnerId)
    .order('accepted_at', { ascending: false }).limit(200)
  if (ownErr) {
    // Migration 0115 not applied: there is no trail yet rather than a failure.
    if (ownErr.code === '42P01' || ownErr.code === 'PGRST205') return ctx.json({ success: true, data: [] })
    throw ownErr
  }
  let fromApplication = []
  if (partner.email && !isRemovedEmail(partner.email)) {
    const exact = String(partner.email).replace(/[\\%_]/g, "\\$&")
    const { data, error } = await supabase.from('partner_terms_acceptances').select(cols).is('partner_id', null)
      .ilike('application_email', exact).order('accepted_at', { ascending: false }).limit(50)
    if (error) throw error
    fromApplication = data || []
  }
  const rows = [...(own || []), ...fromApplication]
    .sort((a, b) => Date.parse(b.accepted_at) - Date.parse(a.accepted_at))
    .map(r => ({ id: r.id, version: r.version, source: r.source, acceptedAt: r.accepted_at, ipHash: r.ip_hash ?? null, userAgent: r.user_agent ?? null }))
  await logAdminAction(ctx, supabase, 'partner.terms_acceptances_viewed', 'partner', partnerId, { count: rows.length })
  return ctx.json({ success: true, data: rows })
}

async function adminTaxSummary(ctx) {
  const supabase = getSupabase(ctx.env)
  const year = statementYearOf(ctx)
  if (!(await auditBeforeReveal(ctx, supabase, 'partner.tax_summary_viewed', 'partner', null, { year }))) return auditUnavailable(ctx)
  const totals = new Map()   // `${partner_id}|${currency}` -> { partnerId, currency, paidCents, payouts }
  let last = null
  for (let page = 0; page < TAX_SUMMARY_MAX_PAYOUT_PAGES; page += 1) {
    let q = supabase.from('payouts').select('id, partner_id, amount_cents, currency')
      .is('voided_at', null).gte('paid_at', `${year}-01-01T00:00:00.000Z`).lt('paid_at', `${year + 1}-01-01T00:00:00.000Z`)
    if (last) q = q.gt('id', last)
    const { data, error } = await q.order('id', { ascending: true }).limit(1000)
    if (error) throw error
    for (const p of data || []) {
      if (isSystemPartnerId(p.partner_id)) continue
      const key = `${p.partner_id}|${p.currency || ''}`
      const t = totals.get(key) || { partnerId: p.partner_id, currency: p.currency || c.activeCurrency(ctx.env), paidCents: 0, payouts: 0 }
      t.paidCents += Number(p.amount_cents) || 0
      t.payouts += 1
      totals.set(key, t)
    }
    if (!data || data.length < 1000) break
    last = data[data.length - 1].id
  }
  const ids = [...new Set([...totals.values()].map(t => t.partnerId))]
  const people = new Map()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('partners').select('id, name, email, tax_country, tax_id').in('id', ids.slice(i, i + 100))
    if (error) throw error
    for (const r of data || []) people.set(r.id, r)
  }
  const rows = []
  for (const t of totals.values()) {
    const p = people.get(t.partnerId)
    if (!p) continue
    const removed = isRemovedEmail(p.email)
    rows.push({ partnerId: t.partnerId, name: removed ? '(removed partner)' : p.name, email: removed ? '' : p.email, currency: t.currency,
      paidCents: t.paidCents, payouts: t.payouts, taxCountry: p.tax_country ?? null, taxId: removed ? null : ((await fieldCrypto.openTaxId(ctx.env, p.tax_id)) || null) })
  }
  rows.sort((a, b) => b.paidCents - a.paidCents)
  return ctx.json({ success: true, year, data: rows })
}

module.exports = {
  adminListTermsAcceptances,
  buildCyclesSummary, buildCycleTrend, buildCodeStats, buildAttributionMix, buildSubMix, sweepPayoutDue, sweepPayoutDetailsReminders,
  adminCreatePartner, adminUpdatePartner, adminListPartners, adminGetPartner,
  adminResendPayoutLink, adminRegeneratePayoutLink, adminGetPartnerLinks, adminRecordPayout,
  adminCreateReferralCode, adminUpdateReferralCode, adminVoidPayout, adminRecordPayoutBatch,
  adminListReferralCodes, adminListPayouts, adminPartnersOverview, adminPayoutRunExport,
  getPartnerStatement, requestPartnerCode, adminListCodeRequests, adminResolveCodeRequest, adminTaxSummary, foldStatementMonths, buildStatementCurrencies, unpaidByCurrency,
  getPartnerByToken, submitPayoutDetails, getPartnerDashboard, getPartnerConversions, getProgramTerms, requestPayoutLink, updatePartnerNotifications, trackClick,
  applyAsPartner, adminListApplications, adminApproveApplication, adminRejectApplication,
  recoverPartnerLinks, adminAnonymizePartner,
  adminAdjustLedger, acceptPartnerTerms, adminSendTermsNotice, adminReopenApplication, adminListLedger,
  resetMyPartnerLinks, setMyReferralAttribution, payoutDetailsEqual, adminReverseSale, adminListUnrecordedCommissions,
  adminRevealPayoutDetails, adminReattributeSale, adminConvertLegacyDashboardLinks
}
