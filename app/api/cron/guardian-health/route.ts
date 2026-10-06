export const runtime = 'nodejs'
export const maxDuration = 120

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { sendEmail } from '@/lib/email/send'
import { systemFrom } from '@/lib/email/from'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import {
  reclassifyCheck, GUARDIAN_SYSTEM_ACTOR, MAX_AUTO_CLASSIFICATION_ATTEMPTS, GUARDIAN_SWEEP_MAX_AGE_DAYS,
  sweepAttemptCutoffs, sweepDueFilter, isSweepDue,
} from '@/lib/ai/guardian-pipeline'
import { recordAiUsageByProject } from '@/lib/utils/rate-limit'
import { logAudit } from '@/lib/utils/audit'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// FIX (build, cron section): this whole route detected real problems
// (elevated classification-failure rate, unresolved failures sitting for
// 24h+) but only ever `console.error`d them — literally commented "Could
// also POST to a Slack webhook here". Nobody was actually paged. This
// isn't scoped to a single workspace (it's a platform-wide health check
// across every workspace's guardian_checks), so it can't go through the
// normal per-workspace notification system — it needs its own ops
// recipient. OPS_ALERT_EMAIL is optional; if unset this still degrades to
// the previous console.error-only behavior rather than crashing the cron.

// FIX (cron audit, section 17 — closing pass): returns whether the send
// actually succeeded. `shouldAlert` below used to mark the cooldown as
// "sent" the instant it decided to alert — before this function even
// attempted delivery — so a Resend failure (bad API key, an outage) still
// consumed the full cooldown window as if the page had gone out. The
// entire point of this route (per the FIX above it) is that someone
// actually gets paged; silently eating the next 1-6 hours of alerts on a
// delivery failure defeats that just as thoroughly as never emailing at
// all did before this route existed.
async function alertOps(subject: string, lines: string[]): Promise<boolean> {
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return false
  // FIX (Notifications & email fix round): the try/catch that used to wrap
  // this could never fire — Resend's SDK resolves `{ error }` instead of
  // throwing — so this always returned true and the cooldown above was
  // consumed by sends that never went out, exactly what the note above says
  // it prevents. sendEmail() reports the real outcome.
  const res = await sendEmail({
    from:    systemFrom('ScopeGov Ops'),
    to,
    subject: `[Guardian Health] ${subject}`,
    html: `<div style="font-family:monospace;white-space:pre-wrap;">${lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')}</div>`,
  })
  if (!res.ok) console.error('Guardian health ops alert email failed:', res.error)
  return res.ok
}

// FIX (cron audit, section 17): this route runs every 15 minutes and had
// no cooldown on either alert — an issue that stays elevated/unresolved
// re-triggered a fresh ops email every single run for as long as it lasted,
// unlike every other recurring notification in this codebase. `key` is a
// stable per-alert-type identifier (this route only has two); `cooldownMs`
// caps how often that specific alert can actually fire an email, while the
// console.error above it still logs every run either way, so nothing about
// server-side visibility is lost — only the inbox spam is.
//
// FIX (cron audit, section 17 — closing pass): split into a read-only
// cooldown check and a separate `markAlerted` write, called only after
// alertOps() reports success — see that function's comment. A failed send
// now leaves the cooldown state untouched, so the very next run (15
// minutes later) tries again instead of going quiet for up to 6 hours.
async function isOnCooldown(service: any, key: string, cooldownMs: number): Promise<boolean> {
  const { data } = await service.from('ops_alert_state').select('last_sent_at').eq('key', key).maybeSingle()
  return !!(data && Date.now() - new Date(data.last_sent_at).getTime() < cooldownMs)
}

async function markAlerted(service: any, key: string): Promise<void> {
  await service.from('ops_alert_state').upsert({ key, last_sent_at: new Date().toISOString() })
}

const SWEEP_BATCH = 10               // AI calls per run (cost + duration bound)
const SWEEP_BUDGET_MS = 90_000       // stop starting new work after this
const SWEEP_MAX_AGE_DAYS = GUARDIAN_SWEEP_MAX_AGE_DAYS // don't resurrect very old backlog

function groupByWorkspace(rows: Array<{ workspace_id: string }>): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.workspace_id, (counts.get(r.workspace_id) || 0) + 1)
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ws, n]) => `  workspace ${ws}: ${n}`).join('\n')
}

// FEATURE (independent pass, section 13): this cron used to only PAGE on classification
// failures. Nothing ever retried them automatically, and checks stored `pending` because no SOW
// was signed at submission time (or because the inbound rate limit was hit) were stranded
// forever — retry only handled classification_failed, by hand. The sweep below re-classifies
// both kinds in place (bounded per run, exponential backoff, capped attempts).
async function sweepUnclassified(service: any) {
  const now = Date.now()
  const oldest = new Date(now - SWEEP_MAX_AGE_DAYS * 86400000).toISOString()
  const cols = 'id, workspace_id, project_id, classification_failed, classification_attempts, last_attempt_at, created_at'
  // Dead rows (soft-deleted project, Complete/Archived project, suspended/deleted workspace) are
  // excluded in the query, not just skipped in reclassifyCheck: a skip happens before the attempt
  // claim, so those rows would keep winning the oldest-first ordering and fill the whole batch
  // forever, starving live checks.
  const live = (q: any) => q
    .is('projects.deleted_at', null)
    .not('projects.status', 'in', '(Complete,Archived)')
    .is('projects.workspaces.deleted_at', null)
    // FIX (independent pass 6, section 13 - P1): a manually paused project is "stop watching this" (see guardian/inbound);
    // excluded in the query for the same starvation reason as the dead rows above. The or() keeps rows whose
    // stall_reason is NULL (every non-stalled project) - a bare neq would drop those too.
    .or('status.neq.Stalled,stall_reason.is.null,stall_reason.neq.manual', { referencedTable: 'projects' })

  // One bounded query per attempt count, each already filtered to rows that are due (see sweepDueFilter), for both
  // kinds; merged oldest-first with failed rows ahead of backlog.
  const buckets = sweepAttemptCutoffs(now)
  const failedSelect = `${cols}, projects!inner(deleted_at, status, workspaces!inner(deleted_at))`
  // Backlog: pending, never failed, and the project NOW has a signed-SOW snapshot.
  const backlogSelect = `${cols}, projects!inner(deleted_at, status, workspaces!inner(deleted_at), project_scope_snapshot!inner(id))`
  const run = (select: string, failed: boolean, c: ReturnType<typeof sweepAttemptCutoffs>[number]) =>
    live(service.from('guardian_checks').select(select))
      .eq('outcome', 'pending').eq('is_duplicate', false).eq('classification_failed', failed)
      .eq('classification_attempts', c.attempts).gte('created_at', oldest)
      .or(sweepDueFilter(c))
      .order('created_at', { ascending: true }).limit(SWEEP_BATCH)
  const [failedResults, backlogResults] = await Promise.all([
    Promise.all(buckets.map(c => run(failedSelect, true, c))),
    Promise.all(buckets.map(c => run(backlogSelect, false, c))),
  ])
  for (const r of failedResults) if (r.error) throw new Error(`guardian sweep (failed): ${r.error.message}`)
  for (const r of backlogResults) if (r.error) throw new Error(`guardian sweep (backlog): ${r.error.message}`)
  const byAge = (x: any, y: any) => String(x.created_at).localeCompare(String(y.created_at))
  const failedRows = failedResults.flatMap((r: any) => r.data || []).sort(byAge)
  const backlogRows = backlogResults.flatMap((r: any) => r.data || []).sort(byAge)

  const candidates = [...failedRows, ...backlogRows].filter((r: any) => isSweepDue(r, now)).slice(0, SWEEP_BATCH)

  const started = Date.now()
  // FIX (independent pass round 2, section 13): `duplicates` is a new bucket — reclassifyCheck
  // did not used to dedup at all on this path, so there was never a status here to distinguish
  // from a plain skip. Counted separately so a run that resolves a pile of backlog duplicates
  // (e.g. the same forwarded email arriving several times before a SOW was signed) is visible as
  // exactly that, not indistinguishable from checks that were simply ineligible this round.
  const stats = { candidates: candidates.length, classified: 0, flagged: 0, failed: 0, duplicates: 0, skipped: 0 }
  // FIX (independent pass 8, section 13 - B1): reclassifyCheck now throws on a failed read/claim instead of reporting a
  // harmless skip. One bad row must not page anyone, but when EVERY item attempted this run threw (>= 3 of them) the
  // database path itself is broken - fail the run (alert + no heartbeat) rather than log a healthy sweep.
  let attempted = 0, errored = 0
  for (const c of candidates) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break
    attempted++
    try {
      // FIX (independent pass round 4, section 13): recordAiUsageByProject used to be called here
      // unconditionally, before reclassifyCheck even looked at the row — so a candidate that
      // reclassifyCheck went on to skip (e.g. a manual retry from the product won the CAS race for
      // this same check in between the sweep's own query and this call) still recorded a spent AI
      // attempt with zero provider calls made. Passed in instead; reclassifyCheck only invokes it
      // once its own claim succeeds — see that function's comment.
      const res = await reclassifyCheck(service, c.id, {
        actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.swept', emailPath: 'automatic re-check',
        requireFailed: false, maxAttempts: MAX_AUTO_CLASSIFICATION_ATTEMPTS, skipManualPause: true,
        recordUsage: () => recordAiUsageByProject(service, c.workspace_id, c.project_id, 'guardian.sweep'),
      })
      if (res.status === 'classified') { stats.classified++; if (res.flagId) stats.flagged++ }
      else if (res.status === 'failed') stats.failed++
      else if (res.status === 'duplicate') stats.duplicates++
      else stats.skipped++
    } catch (e) {
      stats.failed++; errored++
      console.error('Guardian sweep item failed:', c.id, e)
    }
  }
  if (errored >= 3 && errored === attempted) throw new Error(`every one of ${attempted} sweep items threw (last: see logs)`)
  return stats
}

// FIX (Guardian section 13, pass 14 - B9): draft_co (and POST /api/co with a flagId) CLAIM the flag (status converted_to_co) BEFORE the
// change order is inserted and linked. If the function died between those writes (a platform kill, a deploy, a dropped connection) the
// flag stayed converted_to_co with no change_order_id - a state no PATCH action accepts - and nothing ever repaired it, so a live scope
// flag silently vanished from the open queue. Anything stuck that way for 15+ minutes is repaired here: linked to the change order that
// does exist for it, otherwise put back to open. Compare-and-swap on the stuck state, so a request that is still finishing is never undone.
const STRANDED_FLAG_AFTER_MS = 15 * 60000
async function healStrandedFlags(service: any) {
  const cutoff = new Date(Date.now() - STRANDED_FLAG_AFTER_MS).toISOString()
  const { data: stuck, error } = await service.from('guardian_flags')
    .select('id, workspace_id, project_id')
    .eq('status', 'converted_to_co').is('change_order_id', null).lt('updated_at', cutoff)
    .order('updated_at', { ascending: true }).limit(50)
  if (error) throw new Error(`guardian stranded-flag read: ${error.message}`)
  const out = { linked: 0, reopened: 0, failed: 0 }
  for (const f of stuck || []) {
    try {
      // FIX (Guardian section 13, pass 16 - B-F): the earliest CO was linked even when it was already withdrawn / closed / declined /
      // expired / superseded, so the flag stayed at converted_to_co pointing at a dead CO and Guardian refused a new draft. Only a live
      // CO is a link target; with none, the flag is reopened.
      const { data: allCos, error: coErr } = await service.from('change_orders')
        .select('id, status').eq('flag_id', f.id).order('created_at', { ascending: true }).limit(20)
      if (coErr) throw new Error(coErr.message)
      const DEAD_CO = ['withdrawn', 'closed', 'declined', 'expired', 'superseded']
      const cos = (allCos || []).filter((c: any) => !DEAD_CO.includes(c.status)).slice(0, 1)
      const now = new Date().toISOString()
      const patch = cos?.length ? { change_order_id: cos[0].id, updated_at: now } : { status: 'open', updated_at: now }
      const { data: rows, error: upErr } = await service.from('guardian_flags').update(patch)
        .eq('id', f.id).eq('status', 'converted_to_co').is('change_order_id', null).select('id')
      if (upErr) throw new Error(upErr.message)
      if (!rows?.length) continue // someone finished it in the meantime
      if (cos?.length) out.linked++; else out.reopened++
      await logAudit(service, {
        workspaceId: f.workspace_id, actorId: null, actorEmail: GUARDIAN_SYSTEM_ACTOR.email, actorName: GUARDIAN_SYSTEM_ACTOR.name,
        eventType: cos?.length ? 'flag.co_link_repaired' : 'flag.reopened', entityType: 'guardian_flag', entityId: f.id,
        metadata: { reason: 'stranded_conversion', ...(cos?.length ? { co_id: cos[0].id } : {}) },
      })
    } catch (e) {
      out.failed++
      console.error('Guardian stranded-flag repair failed:', f.id, e)
    }
  }
  return out
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient() as any
    const since15m = new Date(Date.now() - 15 * 60000).toISOString()

    // FIX (independent pass, section 13): the failure rate used to be computed in JS over an
    // unpaginated row select (silently capped at PostgREST's 1,000 rows) and its denominator
    // included checks that were never classifiable at all (pending because no SOW was signed),
    // which diluted the rate and could hide a real outage. Exact counts over classifiable checks only.
    const liveOnly = (q: any) => q
      .is('projects.deleted_at', null).is('projects.workspaces.deleted_at', null)
    const liveSel = 'id, projects!inner(deleted_at, workspaces!inner(deleted_at))'
    const windowBase = () => liveOnly(service.from('guardian_checks')
      .select(liveSel, { count: 'exact', head: true })).gte('created_at', since15m).eq('is_duplicate', false)
    const [{ count: totalCount, error: totalErr }, { count: failedCount, error: failedCountErr }] = await Promise.all([
      windowBase().or('classification_failed.eq.true,outcome.neq.pending'),
      windowBase().eq('classification_failed', true),
    ])
    if (totalErr) throw new Error(`guardian-health total: ${totalErr.message}`)
    if (failedCountErr) throw new Error(`guardian-health failed: ${failedCountErr.message}`)

    const total  = totalCount || 0
    const failed = failedCount || 0
    const rate   = total > 0 ? failed / total : 0

    if (rate > 0.01 && total >= 5) {
      const { data: failedRows } = await liveOnly(service.from('guardian_checks')
        .select('workspace_id, projects!inner(deleted_at, workspaces!inner(deleted_at))'))
        .gte('created_at', since15m).eq('is_duplicate', false).eq('classification_failed', true).limit(500)
      const msg = `Classification failure rate: ${(rate * 100).toFixed(1)}% (${failed}/${total} in last 15 min)`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:elevated_failure_rate', 60 * 60000))) {
        if (await alertOps('Elevated classification failure rate', [msg, 'By workspace:', groupByWorkspace(failedRows || [])]))
          await markAlerted(service, 'guardian_health:elevated_failure_rate')
      }
    }

    let healed: Awaited<ReturnType<typeof healStrandedFlags>> | { error: string } = { linked: 0, reopened: 0, failed: 0 }
    try { healed = await healStrandedFlags(service) }
    catch (e) { console.error('Guardian stranded-flag repair error:', e); healed = { error: e instanceof Error ? e.message : 'repair failed' } }

    // ── Sweep: retry failed + classify the backlog ────────────
    let sweep: Awaited<ReturnType<typeof sweepUnclassified>> | { error: string } = { candidates: 0, classified: 0, flagged: 0, failed: 0, duplicates: 0, skipped: 0 }
    try { sweep = await sweepUnclassified(service) }
    catch (e) { console.error('Guardian sweep error:', e); sweep = { error: e instanceof Error ? e.message : 'sweep failed' } }

    // Alert on failures that are still unresolved after 24h (auto-retries included — a check
    // only stays here once the sweep has exhausted its attempts, or the outage is ongoing).
    const since24h = new Date(Date.now() - 24 * 3600000).toISOString()
    // FIX (independent pass, section 13): this alert counted rows the sweep and manual retry can never resolve —
    // duplicates (is_duplicate:true, which have nothing left to classify) and checks on Complete/Archived projects
    // (the sweep excludes them and retry answers 409 "inactive"). Those rows made the alert fire every 6h with no
    // possible remedy. Count only unresolved failures on a live, active project.
    const activeOnly = (q: any) => liveOnly(q).not('projects.status', 'in', '(Complete,Archived)')
    const unresolvedSel = 'id, projects!inner(deleted_at, status, workspaces!inner(deleted_at))'
    const { count: unresolvedCount, error: unresolvedErr } = await activeOnly((service as any)
      .from('guardian_checks')
      .select(unresolvedSel, { count: 'exact', head: true }))
      .eq('classification_failed', true)
      .eq('is_duplicate', false)
      .lt('created_at', since24h)
      .eq('outcome', 'pending')
    // FIX (cron/portal audit round 3): the error was never read, so a failed count looked like "0
    // unresolved failures" — the alert this query exists to raise silently could never fire while the
    // query was failing, and the heartbeat still said healthy. Fail the run (alert + no heartbeat).
    if (unresolvedErr) throw new Error(`guardian-health unresolved-failures count: ${unresolvedErr.message}`)

    if ((unresolvedCount || 0) > 0) {
      const { data: stuckRows } = await activeOnly(service.from('guardian_checks')
        .select('workspace_id, projects!inner(deleted_at, status, workspaces!inner(deleted_at))'))
        .eq('classification_failed', true).eq('is_duplicate', false).eq('outcome', 'pending').lt('created_at', since24h).limit(500)
      const msg = `${unresolvedCount} unresolved classification failures older than 24h`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:unresolved_failures', 6 * 3600000))) {
        if (await alertOps('Unresolved classification failures', [msg, 'By workspace:', groupByWorkspace(stuckRows || [])]))
          await markAlerted(service, 'guardian_health:unresolved_failures')
      }
    }

    // FIX (independent pass 2, section 13 - G3): a sweep that THREW (schema drift, PostgREST error, ...) was folded into
    // `{ error }` and the run still recorded a healthy heartbeat and returned ok:true - nothing paged. The failed-check
    // alerts above only see rows the sweep already failed on; the never-classified backlog (no signed SOW yet,
    // rate-limited inbound) has no alert of its own, so a permanently broken sweep stranded it silently. Same rule as
    // the unresolved-failures count above: fail the run (alertCronFailure + no heartbeat). Placed AFTER the alerts so
    // they still run on a broken sweep.
    if ('error' in sweep) throw new Error(`guardian sweep failed: ${sweep.error}`)
    if ('error' in healed) throw new Error(`guardian stranded-flag repair failed: ${healed.error}`)

    await recordCronHeartbeat(service, 'guardian-health', { total, failed, sweep, healed })
    return NextResponse.json({ ok: true, total, failed, rate: rate.toFixed(3), sweep, healed })
  } catch (err) {
    console.error('Guardian health check error:', err)
    await alertCronFailure(createServiceClient(), 'guardian-health', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (cron audit, section 17 re-pass): the paragraph this replaces claimed
// sow-stall/co-stall/guardian-health were "now scheduled directly in
// vercel.json" — vercel.json is actually `{}` (confirmed on disk); the
// primary scheduler is the external scopegov-cron-worker (Cloudflare
// Worker, not in this repo), with .github/workflows/vercel-crons.yml kept
// as a redundant trigger. That comment was stale and pointed anyone
// debugging "why didn't this cron run" at a file that controls nothing.
export const GET = POST
