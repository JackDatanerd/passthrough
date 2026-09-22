// Admin visibility into everything that ISN'T partners or employer leads
// (users, scans, payments, email logs, alert history) — the leads gap was
// already closed elsewhere (see the NOTE further down); none of the rest
// had any admin-facing read path before, the tables were written to and
// never read back except via direct SQL. Every route here is mounted under
// /api/admin with adminOnly applied at the router level (see admin.routes.js),
// not per-function, since every single endpoint in this file is admin-only.
//
// Deliberately read-only except adminUpdateUser (ban/unban, role, quota
// reset) — this file is visibility + the one piece of user moderation that
// previously had no UI at all (role promotion in particular was documented
// as "DB-only, intentionally"; that stays true — adminUpdateUser only ever
// flips an EXISTING account's role/status, it can't create the first admin).

const { z } = require('zod')
const { revokeVerification, restoreVerification, REVOKE_REASON } = require('../lib/verification')
const { getSupabase } = require('../config/supabase')
const c = require('../config/constants')

// Shared page-param parsing — every list endpoint here is paginated the
// same way so the frontend can use one generic table component for all of
// them. Capped at 100/page so a stray `?pageSize=100000` can't turn a list
// endpoint into an accidental full-table dump.
function pageParams(ctx, defaultSize = 25, maxSize = 100) {
  const page     = Math.max(1, parseInt(ctx.req.query('page') || '1', 10) || 1)
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(ctx.req.query('pageSize') || String(defaultSize), 10) || defaultSize))
  return { page, pageSize, from: (page - 1) * pageSize, to: (page - 1) * pageSize + pageSize - 1 }
}

// Strips characters that would break PostgREST's `.or()` filter-string
// syntax (commas separate conditions, parens group them) — this is an
// internal admin search box, not attacker-facing, but a stray comma should
// mean "no results for that weird search", not a malformed query.
function sanitizeSearchTerm(term) {
  return String(term || '').trim().replace(/[,()]/g, '')
}

// ── Dashboard — the roll-up numbers that didn't exist anywhere before ──────

async function adminDashboardStats(ctx) {
  const supabase = getSupabase(ctx.env)
  const now = new Date()
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const startOfWeek  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const oneHourAgo   = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  // AUDIT FIX (Admin panel re-audit): today/week/month were all sliced from
  // ONE query that only fetched created_at >= startOfMonth — correct for
  // "today" and "month" (both subsets of the month), but "week" is NOT
  // always a subset: on the 1st-6th of any month, `now - 7 days` reaches
  // back into the PREVIOUS month, and those trailing days were never
  // fetched at all, so "Revenue this week" silently undercounted near every
  // month boundary. Fetch from whichever boundary is earliest instead, and
  // filter each bucket from that one superset.
  const queryFrom = startOfWeek < startOfMonth ? startOfWeek : startOfMonth

  const { data: revenueWindowPayments, error: payErr } = await supabase
    .from('payments').select('amount_cents, created_at').eq('status', 'SUCCESS').gte('created_at', queryFrom)
  if (payErr) throw payErr

  const { data: pendingLedger, error: ledgerErr } = await supabase
    .from('commission_ledger').select('commission_amount_cents').is('payout_id', null)
  if (ledgerErr) throw ledgerErr

  // Scans that flipped to ERROR recently — updated_at moves whenever status
  // changes (see the set_updated_at trigger), so this is "recently errored",
  // not "ever errored".
  const { count: erroredScansCount, error: scanErr } = await supabase
    .from('scans').select('id', { count: 'exact', head: true })
    .eq('status', 'ERROR').gte('updated_at', startOfWeek)
  if (scanErr) throw scanErr

  // Scans the hourly cron hasn't yet caught (it only sweeps every hour and
  // only flips things stuck > 30 min) — surfaces the gap between "actually
  // stuck" and "the cron noticed."
  const { count: stuckScansCount, error: stuckErr } = await supabase
    .from('scans').select('id', { count: 'exact', head: true })
    .in('status', ['SCANNING', 'FIX_GENERATING']).lt('updated_at', oneHourAgo)
  if (stuckErr) throw stuckErr

  // Payments left PENDING past a reasonable window — includes the
  // "amount mismatch, held for manual review" case from payments.controller.js
  // and webhooks.controller.js, which previously only existed as an email alert.
  const { count: stalePendingCount, error: pendErr } = await supabase
    .from('payments').select('id', { count: 'exact', head: true })
    .eq('status', 'PENDING').lt('created_at', oneHourAgo)
  if (pendErr) throw pendErr

  const { count: leadsThisWeekCount, error: leadErr } = await supabase
    .from('employer_leads').select('id', { count: 'exact', head: true }).gte('created_at', startOfWeek)
  if (leadErr) throw leadErr

  const { data: recentAlerts, error: alertErr } = await supabase
    .from('alert_logs').select('id, subject, message, emailed, created_at')
    .order('created_at', { ascending: false }).limit(5)
  if (alertErr) throw alertErr

  const revenueMonthCents = (revenueWindowPayments || []).filter(p => p.created_at >= startOfMonth).reduce((sum, p) => sum + p.amount_cents, 0)
  const revenueWeekCents  = (revenueWindowPayments || []).filter(p => p.created_at >= startOfWeek).reduce((sum, p) => sum + p.amount_cents, 0)
  const revenueTodayCents = (revenueWindowPayments || []).filter(p => p.created_at >= startOfToday).reduce((sum, p) => sum + p.amount_cents, 0)
  const totalPendingCommissionCents = (pendingLedger || []).reduce((sum, l) => sum + l.commission_amount_cents, 0)

  return ctx.json({ success: true, data: {
    revenue: { todayCents: revenueTodayCents, weekCents: revenueWeekCents, monthCents: revenueMonthCents },
    totalPendingCommissionCents,
    // Read-only status readout — constants.js/wrangler.toml stay the single
    // source of truth for pricing by design (see constants.js's own
    // comment); this just makes what's currently live impossible to miss,
    // instead of requiring someone to check wrangler.toml's committed dates.
    promo: {
      active: c.isPromoActive(ctx.env),
      endsAt: ctx.env.PROMO_ENDS_AT || null,
      standardCents: { FIX: c.PRICE_FIX, BADGE: c.PRICE_BADGE, FIX_PLAIN: c.PRICE_FIX_PLAIN },
      promoCents:    { FIX: c.PROMO_PRICE_FIX, BADGE: c.PROMO_PRICE_BADGE, FIX_PLAIN: c.PROMO_PRICE_FIX_PLAIN }
    },
    openItems: {
      erroredScansThisWeek: erroredScansCount || 0,
      stuckScans:           stuckScansCount || 0,
      stalePendingPayments: stalePendingCount || 0,
      leadsThisWeek:        leadsThisWeekCount || 0
    },
    recentAlerts: (recentAlerts || []).map(a => ({
      id: a.id, subject: a.subject, message: a.message, emailed: a.emailed, createdAt: a.created_at
    }))
  }})
}

// ── Users ────────────────────────────────────────────────────────────────
// Never selects password_hash, paystack_customer_code, paystack_auth_code,
// reset_token(_expiry), or email_verify_token(_expiry) — same "never touches
// the client" discipline optionalAuth.js already applies, just enforced
// here by simply never selecting those columns in the first place.

const USER_LIST_FIELDS = 'id, email, name, role, status, email_verified, scans_today, scans_day_reset, created_at'

async function adminListUsers(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)
  const search = sanitizeSearchTerm(ctx.req.query('search'))
  const status = ctx.req.query('status')
  const role   = ctx.req.query('role')

  let query = supabase.from('users').select(USER_LIST_FIELDS, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to)
  if (search) query = query.or(`email.ilike.%${search}%,name.ilike.%${search}%`)
  if (status) query = query.eq('status', status)
  if (role)   query = query.eq('role', role)

  const { data, error, count } = await query
  if (error) throw error

  const users = data.map(u => ({
    id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
    emailVerified: u.email_verified, scansToday: u.scans_today, scansDayReset: u.scans_day_reset,
    createdAt: u.created_at
  }))
  return ctx.json({ success: true, data: users, meta: { page, pageSize, total: count || 0 } })
}

async function adminGetUserDetail(ctx) {
  const userId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)

  const { data: user, error } = await supabase.from('users').select(USER_LIST_FIELDS).eq('id', userId).maybeSingle()
  if (error) throw error
  if (!user) return ctx.json({ success: false, message: 'User not found.' }, 404)

  const { data: scans, error: scanErr } = await supabase
    .from('scans').select('id, status, ats_score, fix_purchased, fix_tier, resume_original_name, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
  if (scanErr) throw scanErr

  const { data: payments, error: payErr } = await supabase
    .from('payments').select('id, amount_cents, currency, status, fix_tier, referral_code, created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
  if (payErr) throw payErr

  return ctx.json({ success: true, data: {
    id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
    emailVerified: user.email_verified, scansToday: user.scans_today, scansDayReset: user.scans_day_reset,
    createdAt: user.created_at,
    scans: (scans || []).map(s => ({
      id: s.id, status: s.status, atsScore: s.ats_score, fixPurchased: s.fix_purchased,
      fixTier: s.fix_tier, resumeOriginalName: s.resume_original_name, createdAt: s.created_at
    })),
    payments: (payments || []).map(p => ({
      id: p.id, amountCents: p.amount_cents, currency: p.currency, status: p.status,
      fixTier: p.fix_tier, referralCode: p.referral_code, createdAt: p.created_at
    }))
  }})
}

const updateUserSchema = z.object({
  status:           z.enum(['ACTIVE', 'BANNED']).optional(),
  role:             z.enum(['SEEKER', 'ADMIN']).optional(),
  resetScansToday:  z.boolean().optional()
}).refine(obj => Object.keys(obj).length > 0, 'At least one field is required.')

async function adminUpdateUser(ctx) {
  const userId = ctx.req.param('id')
  const body = updateUserSchema.parse(await ctx.req.json())
  const actingUser = ctx.get('user')

  // Guardrail, not a security boundary (the DB would happily let an admin
  // do this to themselves) — just cheap insurance against a solo admin
  // locking themselves out of their own panel by fat-fingering their own row.
  if (actingUser?.id === userId && (body.status === 'BANNED' || body.role === 'SEEKER')) {
    return ctx.json({ success: false, message: "You can't ban or demote your own account from here." }, 400)
  }

  const supabase = getSupabase(ctx.env)
  const patch = {}
  if (body.status !== undefined) patch.status = body.status
  if (body.role !== undefined)   patch.role = body.role
  if (body.resetScansToday) { patch.scans_today = 0; patch.scans_day_reset = new Date().toISOString() }

  const { data, error } = await supabase.from('users').update(patch).eq('id', userId).select(USER_LIST_FIELDS).maybeSingle()
  if (error) throw error
  if (!data) return ctx.json({ success: false, message: 'User not found.' }, 404)

  // No extra token-invalidation step needed here: optionalAuth.js re-checks
  // status==='BANNED' and re-reads role fresh from the DB on every single
  // request (it doesn't trust the JWT payload for either) — so a ban or a
  // role change already takes effect on the user's very next request,
  // before their existing 7-day JWT would otherwise expire.
  return ctx.json({ success: true, data: {
    id: data.id, email: data.email, name: data.name, role: data.role, status: data.status,
    scansToday: data.scans_today, scansDayReset: data.scans_day_reset
  }})
}

// ── Scans ────────────────────────────────────────────────────────────────

async function adminListScans(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)
  const status = ctx.req.query('status')

  let query = supabase.from('scans')
    .select('id, status, ats_score, fix_purchased, fix_tier, resume_original_name, user_id, users(email), verification_code, verification_status, verification_revoked_reason, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to)
  if (status) query = query.eq('status', status)

  const { data, error, count } = await query
  if (error) throw error

  const scans = data.map(s => ({
    id: s.id, status: s.status, atsScore: s.ats_score, fixPurchased: s.fix_purchased, fixTier: s.fix_tier,
    resumeOriginalName: s.resume_original_name, userId: s.user_id, userEmail: s.users?.email || null,
    verificationCode: s.verification_code, verificationStatus: s.verification_status,
    verificationRevokedReason: s.verification_revoked_reason,
    createdAt: s.created_at, updatedAt: s.updated_at
  }))
  return ctx.json({ success: true, data: scans, meta: { page, pageSize, total: count || 0 } })
}

// PATCH /api/admin/scans/:id/verification  { action: 'revoke' | 'restore' }
// SECTION 7 AUDIT (feature gap): a public credential page had no off switch for
// abuse/takedown. An admin revoke is stronger than an owner unpublish (the
// owner cannot undo it); restore lifts ANY revocation.
async function adminSetVerification(ctx) {
  const { action } = z.object({ action: z.enum(['revoke', 'restore']) }).parse(await ctx.req.json())
  const scanId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)

  const { data: scan, error } = await supabase.from('scans').select('id, verification_code').eq('id', scanId).maybeSingle()
  if (error) throw error
  if (!scan) return ctx.json({ success: false, message: 'Scan not found.' }, 404)
  if (!scan.verification_code) return ctx.json({ success: false, message: 'This scan has no verification page.' }, 400)

  const changed = action === 'revoke'
    ? await revokeVerification(supabase, scanId, REVOKE_REASON.ADMIN)
    : await restoreVerification(supabase, scanId, { asAdmin: true })
  return ctx.json({ success: true, data: { changed, verificationStatus: action === 'revoke' ? 'REVOKED' : 'ACTIVE' } })
}

// ── Payments ─────────────────────────────────────────────────────────────

async function adminListPayments(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)
  const status = ctx.req.query('status')

  let query = supabase.from('payments')
    .select('id, amount_cents, currency, status, paystack_ref, fix_tier, referral_code, scan_id, user_id, users(email), created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to)
  if (status) query = query.eq('status', status)

  const { data, error, count } = await query
  if (error) throw error

  const payments = data.map(p => ({
    id: p.id, amountCents: p.amount_cents, currency: p.currency, status: p.status,
    paystackRef: p.paystack_ref, fixTier: p.fix_tier, referralCode: p.referral_code,
    scanId: p.scan_id, userId: p.user_id, userEmail: p.users?.email || null, createdAt: p.created_at
  }))
  return ctx.json({ success: true, data: payments, meta: { page, pageSize, total: count || 0 } })
}

// NOTE: employer-lead listing is NOT duplicated here — a separate pass on
// this repo already closed that exact gap (GET /api/employer-leads,
// admin-gated, in employer-leads.controller.js's adminListLeads). The admin
// panel's Leads page calls that existing endpoint directly rather than a
// second one living here.

// ── System health: email delivery log + persisted alert history ──────────

async function adminListEmailLogs(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)
  const status   = ctx.req.query('status')
  const template = ctx.req.query('template')
  const search   = sanitizeSearchTerm(ctx.req.query('search'))

  let query = supabase.from('email_logs')
    .select('id, to, subject, template, status, error, sent_at', { count: 'exact' })
    .order('sent_at', { ascending: false }).range(from, to)
  if (status)   query = query.eq('status', status)
  if (template) query = query.eq('template', template)
  if (search)   query = query.ilike('to', `%${search}%`)

  const { data, error, count } = await query
  if (error) throw error

  const logs = data.map(l => ({
    id: l.id, to: l.to, subject: l.subject, template: l.template, status: l.status,
    error: l.error, sentAt: l.sent_at
  }))
  return ctx.json({ success: true, data: logs, meta: { page, pageSize, total: count || 0 } })
}

async function adminListAlerts(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)

  const { data, error, count } = await supabase
    .from('alert_logs')
    .select('id, subject, message, emailed, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to)
  if (error) throw error

  const alerts = data.map(a => ({
    id: a.id, subject: a.subject, message: a.message, emailed: a.emailed, createdAt: a.created_at
  }))
  return ctx.json({ success: true, data: alerts, meta: { page, pageSize, total: count || 0 } })
}

// POST /api/admin/scans/:id/requeue-fix
//
// The manual escape hatch for a customer who PAID and whose fix failed to
// generate. The automatic sweep (reconcile.service.js's sweepFailedFixes) gives
// up after a fixed number of attempts so a deterministic failure can't loop
// forever; once it has, this is the way to run the job again after the cause
// has been dealt with. Uses the same atomic claim as the sweep — so it cannot
// double-enqueue against it — but with no attempt cap.
async function adminRequeueFix(ctx) {
  const scanId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)

  const { data: scan, error } = await supabase
    .from('scans').select('id, status, fix_purchased, fix_tier').eq('id', scanId).maybeSingle()
  if (error) throw error
  if (!scan) return ctx.json({ success: false, message: 'Scan not found.' }, 404)
  if (!scan.fix_purchased)
    return ctx.json({ success: false, message: 'This scan has no purchased fix — nothing to re-run.' }, 400)

  const { data: claimed, error: claimErr } = await supabase.rpc('claim_errored_fix', { p_scan_id: scanId, p_max: 1000 })
  if (claimErr) throw claimErr
  if (!claimed)
    return ctx.json({ success: false,
      message: `Only a paid scan currently in ERROR can be re-queued (this one is ${scan.status}).` }, 409)

  await ctx.env.FIX_QUEUE.send({ type: scan.fix_tier === 'BADGE' ? 'generateBadge' : 'generateFix', scanId })
  return ctx.json({ success: true, message: 'Re-queued. The customer will be emailed when it is ready.' })
}

module.exports = {
  adminRequeueFix,
  adminDashboardStats,
  adminListUsers, adminGetUserDetail, adminUpdateUser,
  adminListScans, adminSetVerification, adminListPayments,
  adminListEmailLogs, adminListAlerts
}
