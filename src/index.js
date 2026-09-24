// !! THIS FILE USES ESM (import/export) — ALL OTHER FILES USE CommonJS !!
//
// This is the sole exception to the project's CommonJS convention.
// Wrangler only recognizes "Module Worker" format — which enables the
// nodejs_compat polyfills every dependency needs — by finding an
// `export default` in the entry point file. Without it, Wrangler silently
// falls back to "Service Worker" format and the bundled code breaks at
// runtime. See Section 9 of the migration patch for the full explanation.
//
// esbuild (Wrangler's bundler) handles the import/require mix: this file
// uses `import` while everything it requires uses `require`/`module.exports`.
// That is fine and expected — do not convert any other file to ESM.

import { Hono } from 'hono'
import { cors } from 'hono/cors'

// All requires below are CommonJS — esbuild bundles them cleanly.
const optionalAuth     = require('./middleware/optionalAuth')
const errorHandler     = require('./middleware/errorHandler')
const rateLimiter      = require('./middleware/rateLimiter')
const bodyLimit         = require('./middleware/bodyLimit')
const envCheck          = require('./middleware/envCheck')
const securityHeaders   = require('./middleware/securityHeaders')

const authRoutes         = require('./routes/auth.routes')
const scanRoutes         = require('./routes/scan.routes')
const paymentsRoutes     = require('./routes/payments.routes')
const webhooksRoutes     = require('./routes/webhooks.routes')
const verifyRoutes       = require('./routes/verify.routes')
const employerLeadRoutes = require('./routes/employer-leads.routes')
const pricingRoutes = require('./routes/pricing.routes')
const profileRoutes      = require('./routes/profile.routes')
const partnersRoutes     = require('./routes/partners.routes')
const adminRoutes        = require('./routes/admin.routes')

const { getSupabase } = require('./config/supabase')
const { scanRowToCamel } = require('./lib/mappers')
const emailService = require('./services/email.service')
const { runRetention } = require('./services/retention.service')
const { runLeadMatchSweep } = require('./services/lead-match.service')
const { handleDeadLetterBatch } = require('./services/deadletter.service')

const app = new Hono()

// CRITICAL BUG FIX (traced cross-section — found while adapting Section 5/6
// fixes to this snapshot; src/index.js is nobody's assigned section): all
// three of bodyLimit.js, envCheck.js and securityHeaders.js exist, are fully
// implemented, and are exercised by tests/infra.middleware.test.js — but
// none of them were ever require()'d or app.use()'d here. Every doc comment
// in those three files already describes itself as active ("wraps the whole
// app", "mounted app-wide") — that description was aspirational, not true:
// no response has ever actually carried these security headers, no request
// has ever actually been size-capped outside of upload.js's own multipart
// path, and a fatal misconfiguration has never actually short-circuited into
// the 503 it was built to produce. Wiring them in is the fix; nothing about
// their own logic needed to change.
app.use('*', securityHeaders)   // wraps every response, success or error — mount first
app.use('/api/*', envCheck)     // fail fast on a broken config before any route runs
app.use('/api/*', bodyLimit())  // caps non-multipart bodies before a handler reads one

// ── 1. CORS ──────────────────────────────────────────────────────────────────
// origin is set at request time from env.FRONTEND_URL (not hardcoded) so the
// same Worker build works against both dev (localhost:3000) and prod.
app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin:      c.env.FRONTEND_URL,
    credentials: true,
    // Readable by the frontend: how many parts the account's data export has
    // (GET /api/profile/export) — a cross-origin response hides custom
    // headers unless they are exposed here.
    exposeHeaders: ['X-Export-Parts'],
  })
  return corsMiddleware(c, next)
})

// ── 1b. Health check ──────────────────────────────────────────────────────────
// AUDIT FIX (Section 9, feature gap): nothing existed for an uptime monitor
// to poll — every external check had to hit a real business route (and, for
// anything under /api/*, burn into that IP's general rate-limit budget).
// Deliberately outside /api/* (skips both the general limiter and any
// future route-specific auth) and deliberately does NOT touch Supabase —
// this only proves the Worker itself is up and routing requests; a DB-down
// scenario should show up as real endpoints failing, not as this failing
// too and paging on the same incident twice.
app.get('/healthz', c => c.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }))

// ── 2. General rate limit ─────────────────────────────────────────────────────
app.use('/api/*', rateLimiter.general)

// ── 3. optionalAuth app-wide — c.get('user') available on every route ─────────
app.use('*', optionalAuth)

// ── 4. Mount routes ───────────────────────────────────────────────────────────
app.route('/api/auth',           authRoutes)
app.route('/api/scan',           scanRoutes)
app.route('/api/payments',       paymentsRoutes)
app.route('/api/webhooks',       webhooksRoutes)  // normal route, not a stub
app.route('/api/verify',         verifyRoutes)
app.route('/api/employer-leads', employerLeadRoutes)
app.route('/api/profile',        profileRoutes)
app.route('/api/pricing',        pricingRoutes)
app.route('/api/partners',       partnersRoutes)
app.route('/api/admin',          adminRoutes)

// ── 5. Error handler ──────────────────────────────────────────────────────────
app.onError(errorHandler)

// ── 6. 404 ────────────────────────────────────────────────────────────────────
app.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))

// ── SCHEDULED HANDLER (replaces the old setInterval in server.js) ────────────
// Triggered by the cron in wrangler.toml: "0 * * * *" (every hour).
// Deletes anonymous scans whose anon_expires_at has passed, and removes
// their files from R2. Functionally identical to the v8 setInterval cleanup.
async function scheduled(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const supabase = getSupabase(env)
        // ROUND-2 AUDIT FIX (bug, traced from Section 8): this job ALSO purged
        // expired anonymous scans — the same thing retentionSweep() does, on the
        // same hourly tick, concurrently. This copy swallowed R2 delete errors
        // (`.catch(() => {})`) and then deleted the DB rows regardless, which
        // defeated retention.service.js's deliberate "keep the row if its R2
        // object could not be deleted, so the next run retries" rule: a failed
        // delete left an orphaned resume file with personal data and no row
        // pointing at it. The anon purge now lives ONLY in retention.service.js.
        //
        // Recover stuck PENDING / SCANNING / FIX_GENERATING scans (replaces the server.js
        // startup recovery — here it runs hourly instead).
        const { data: stuck, error: stuckErr } = await supabase
          .from('scans')
          .update({ status: 'ERROR' })
          // PENDING too: a scan whose background job died before it could even
          // mark itself SCANNING (a deploy or eviction in that window) sat at
          // PENDING forever — nothing recovered it, and the dashboard could
          // never offer to delete it.
          .in('status', ['PENDING', 'SCANNING', 'FIX_GENERATING'])
          .lt('updated_at', new Date(Date.now() - 30 * 60 * 1000).toISOString()) // stuck > 30 min
          .select('id')
        if (stuckErr) { console.error('Stuck scan recovery:', stuckErr.message); return }
        if (stuck?.length > 0) console.log(`Recovered ${stuck.length} stuck scan(s) → ERROR`)
      } catch (err) {
        console.error('Scheduled handler error:', err.message)
      }
    })()
  )
}

// ROUND-2 AUDIT FIX (bug, traced from Section 8): reconcile.service.js's
// sweepFailedFixes — "paid, but generation FAILED" — was written, exported and
// tested, and referenced by the dead-letter alert and the admin requeue endpoint
// as "the automatic sweep", but nothing ever CALLED it. A paying customer whose
// generation hung or died (the stuck-job recovery above flips it to ERROR with no
// notification) stayed at ERROR until someone noticed by hand. Its own waitUntil
// + try/catch, same isolation as every other job here.
async function failedFixSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const { sweepFailedFixes } = require('./services/reconcile.service')
        const r = await sweepFailedFixes(env, getSupabase(env))
        if (r.error) console.error('Failed-fix sweep query:', r.error)
        else if (r.requeued.length || r.exhausted.length || r.failed.length)
          console.log(`Failed-fix sweep: ${r.candidates} candidate(s), ${r.requeued.length} re-queued, ${r.exhausted.length} exhausted, ${r.failed.length} failed`)
      } catch (err) {
        console.error('Failed-fix sweep error:', err.message)
      }
    })()
  )
}

// SECTION 7/8 AUDIT FIX (bug): this whole job — the pending-payment sweep
// (sweepPendingPayments, "Section 8 audit (feature gap)" per
// reconcile.service.js) and the webhook_events retention prune — used to sit
// here as bare top-level statements, OUTSIDE every function, left behind
// when `scheduled()` above was split into the separate named jobs below.
// `env` doesn't exist at module scope in a Worker, so every run of this threw
// ReferenceError immediately, silently caught by each block's own try/catch —
// and because it was top-level code, "every run" meant ONCE, at module
// evaluation on cold start, not hourly like every other job here. Net effect:
// a payment Paystack marked paid but this app never got the webhook for was
// never automatically recovered (the feature existed, tested, wired to
// nothing), and webhook_events grew forever. Moving it into a fourth
// registered job — same shape, same isolation, as the two below — is the fix;
// nothing about the two try/catch blocks themselves needed to change.
async function webhookMaintenanceSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      // Independent of the sweep above: a failure in one must never skip the other.
      try {
        const { sweepPendingPayments } = require('./services/reconcile.service')
        const p = await sweepPendingPayments(env, getSupabase(env))
        if (p.error) console.error('Pending-payment sweep query:', p.error)
        else if (p.recovered.length || p.failed.length)
          console.log(`Pending-payment sweep: checked ${p.checked}, ${p.recovered.length} recovered, ${p.failed.length} failed`)
      } catch (err) {
        console.error('Pending-payment sweep error:', err.message)
      }
      // webhook_events is an audit log, not an archive.
      try {
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
        await getSupabase(env).from('webhook_events').delete().lt('received_at', cutoff).in('status', ['PROCESSED', 'IGNORED'])
      } catch (err) {
        console.error('webhook_events prune error:', err.message)
      }
    })()
  )
}

// Second, independent scheduled job: recover paid-but-undelivered payments
// (see services/reconcile.service.js for why fulfilment is one-shot and what
// "orphaned" means). Its own waitUntil + try/catch so a failure here can never
// affect the cleanup job above, and vice versa.
async function reconcileSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const { sweepOrphanedPayments } = require('./services/reconcile.service')
        const r = await sweepOrphanedPayments(env, getSupabase(env))
        if (r.error) console.error('Payment sweep query:', r.error)
        else if (r.orphans > 0) console.log(`Payment sweep: ${r.orphans} orphan(s), ${r.reenqueued.length} recovered, ${r.failed.length} failed`)
      } catch (err) {
        console.error('Payment sweep error:', err.message)
      }
    })()
  )
}

// Third, independent scheduled job: mark PENDING payments ABANDONED once
// they're old enough that nothing further will ever legitimately happen to
// them (see services/reconcile.service.js's sweepStalePendingPayments for
// the age margin and race reasoning). Its own waitUntil + try/catch, same
// isolation as the two jobs above.
async function pendingSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const { sweepStalePendingPayments } = require('./services/reconcile.service')
        const r = await sweepStalePendingPayments(env, getSupabase(env))
        if (r.error) console.error('Pending payment sweep query:', r.error)
        else if (r.checked > 0) console.log(`Pending payment sweep: ${r.abandoned}/${r.checked} marked ABANDONED`)
      } catch (err) {
        console.error('Pending payment sweep error:', err.message)
      }
    })()
  )
}

// ── QUEUE CONSUMER (replaces the old waitUntil(generateFix(...)) pattern) ────
// generateFix/generateBadge do two sequential Claude calls plus a Browser
// Rendering PDF render — realistically 20-45+ seconds. ctx.waitUntil() has a
// hard, non-configurable 30-second wall-clock cap after the HTTP response is
// sent (shared across all waitUntil work in that request), and when the
// platform kills a waitUntil task mid-flight it is NOT a catchable JS
// exception — the function just stops, including its own error-handling
// catch block, leaving the scan stuck at FIX_GENERATING forever.
//
// A queue consumer invocation has no such wall-clock cap — only the normal
// CPU-time limit (default 30s of ACTIVE processing, not wall time; network
// waits on Claude/Browser Rendering don't count against it, and it can be
// raised via limits.cpu_ms in wrangler.toml if ever needed). This is
// Cloudflare's own documented recommendation for exactly this situation:
// https://developers.cloudflare.com/workers/runtime-apis/context/
//
// max_batch_size = 1 in wrangler.toml — each job is heavy enough (two Claude
// calls + a browser render) that batching several per invocation would just
// reintroduce the same time-pressure problem one level up.
//
// generateFix/generateBadge already catch their own errors internally and
// mark the scan status='ERROR' rather than rejecting (see scan.controller.js)
// — so under normal operation this promise never rejects, and message.ack()
// is the common path. message.retry() only fires for something the functions'
// own error handling didn't catch (a genuine platform-level failure), which
// is the correct place for the queue's built-in retry/DLQ behavior to apply.
async function queue(batch, env, ctx) {
  // Cloudflare routes every queue this Worker consumes (the fix-jobs queue
  // AND its dead-letter queue — see wrangler.toml) to this same export,
  // distinguished by batch.queue. A job that ends up HERE already exhausted
  // the main queue's retries; see deadletter.service.js for what happens to
  // it — never regular fix generation.
  if (batch.queue.endsWith('-dlq')) {
    const supabase = getSupabase(env)
    return handleDeadLetterBatch(batch, env, supabase, emailService)
  }

  const { generateFix, generateBadge } = require('./controllers/scan.controller')
  const supabase = getSupabase(env)

  for (const message of batch.messages) {
    const { type, scanId } = message.body || {}
    if (!scanId || (type !== 'generateFix' && type !== 'generateBadge')) {
      console.error('Queue message malformed, dropping:', JSON.stringify(message.body))
      message.ack()  // not retryable — will never become valid
      continue
    }
    try {
      const generator = type === 'generateBadge' ? generateBadge : generateFix
      const outcome = await generator(env, supabase, scanId)
      if (outcome?.success) {
        console.log(`Queue job succeeded: ${type} ${scanId}`)
      } else {
        // generateFix/generateBadge already marked status='ERROR' on the scan
        // row themselves — this is purely so wrangler tail shows the real
        // outcome instead of a misleading blanket "Ok" on every invocation.
        console.error(`Queue job completed but reported failure: ${type} ${scanId} — ${outcome?.error || 'no error detail returned'}`)
      }
      message.ack()
    } catch (err) {
      // Should be rare — generateFix/generateBadge handle their own errors —
      // but if something truly unexpected escapes, let the queue's
      // max_retries/dead_letter_queue config (wrangler.toml) handle it.
      console.error(`Queue job failed (${type} ${scanId}):`, err.message)
      // Awaited, not fire-and-forget — an unawaited promise here risks
      // being silently cancelled once this function returns, the exact
      // class of bug found and fixed elsewhere tonight.
      try {
        await emailService.sendOwnerAlert(env,
          `Queue job failed: ${type}`,
          `scanId: ${scanId}\ntype: ${type}\nerror: ${err.message}\nstack: ${err.stack || '(none)'}`
        )
      } catch (_) {}
      message.retry()
    }
  }
}

// ── EXPORT ────────────────────────────────────────────────────────────────────
// fetch (HTTP requests), scheduled (cron), and queue (background job
// processing) must all be on the same default export for Wrangler to wire
// them up correctly.
// AUDIT FIX (Section 9/10, feature gap — data retention): email_logs and
// alert_logs grew forever, and reset/verification tokens outlived their
// expiry sitting readable in the users row. runRetention (own isolated
// waitUntil, same as every job above) purges/clears all of that on the same
// hourly cron — see services/retention.service.js.
// Owner digest: fields where employer leads are waiting and verified-candidate
// supply has grown (see services/lead-match.service.js). Same hourly cron, own
// waitUntil + try/catch; the service itself limits how often it actually
// sends (one digest per day at most).
async function leadMatchSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const r = await runLeadMatchSweep(env, getSupabase(env))
        if (r.error) console.error('Lead-match sweep:', r.error)
        else if (r.announced) console.log(`Lead-match sweep: digest sent for ${r.announced} field(s)`)
      } catch (err) {
        console.error('Lead-match sweep error:', err.message)
      }
    })()
  )
}

async function retentionSweep(event, env, ctx) {
  ctx.waitUntil(
    (async () => {
      try {
        const supabase = getSupabase(env)
        const r = await runRetention(env, supabase)
        // AUDIT FIX (Section 9/10 pass): pendingEmailTokens (added to
        // clearExpiredTokens by retention.service.js when pending_email_token
        // was added to its own sweep) was missing from this summary line —
        // the sweep itself was already clearing them correctly, this was
        // purely a wrangler-tail visibility gap.
        console.log(`Retention sweep: ${r.anon.deleted} anon scan(s), ${r.logs.emailLogs} email_logs, ${r.logs.alertLogs} alert_logs, ${r.tokens.resetTokens} reset + ${r.tokens.verifyTokens} verify + ${r.tokens.pendingEmailTokens} pending-email token(s) cleared, ${r.leads.deleted} archived lead(s) purged`)
        for (const e of [...(r.logs.errors || []), ...(r.tokens.errors || [])]) console.error('Retention sweep:', e)
        if (r.anon.error) console.error('Retention sweep (anon):', r.anon.error)
        if (r.leads.error) console.error('Retention sweep (leads):', r.leads.error)
      } catch (err) {
        console.error('Retention sweep error:', err.message)
      }
    })()
  )
}

export default {
  fetch: app.fetch,
  // One cron trigger, seven independent jobs — each isolated by its own
  // waitUntil + try/catch, so a failure in any one of them can never skip or
  // crash the others.
  scheduled: (event, env, ctx) => {
    scheduled(event, env, ctx)
    reconcileSweep(event, env, ctx)
    pendingSweep(event, env, ctx)
    webhookMaintenanceSweep(event, env, ctx)
    leadMatchSweep(event, env, ctx)
    failedFixSweep(event, env, ctx)
    return retentionSweep(event, env, ctx)
  },
  queue,
}
