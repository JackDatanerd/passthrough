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
const optionalAuth  = require('./middleware/optionalAuth')
const errorHandler  = require('./middleware/errorHandler')
const rateLimiter   = require('./middleware/rateLimiter')

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

const app = new Hono()

// ── 1. CORS ──────────────────────────────────────────────────────────────────
// origin is set at request time from env.FRONTEND_URL (not hardcoded) so the
// same Worker build works against both dev (localhost:3000) and prod.
app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin:      c.env.FRONTEND_URL,
    credentials: true,
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
        // AUDIT FIX (bug — Scan/ATS section audit): this used to compute its
        // own independent cutoff as `now - 24h` and compare THAT against
        // anon_expires_at — but anon_expires_at is already the absolute
        // expiry timestamp (createScan sets it to `now + ANON_SCAN_TTL_HOURS`
        // at creation time). Comparing `anon_expires_at < now - 24h` is
        // equivalent to `creation_time + 24h < now - 24h`, i.e.
        // `creation_time < now - 48h` — the cron was silently re-applying
        // the same 24h TTL a second time on top of a column that already
        // had it applied once, doubling real retention to ~48h. The two
        // numbers only ever looked consistent because both happened to be
        // hardcoded to 24 — changing ANON_SCAN_TTL_HOURS in constants.js
        // (the single place the app tells you retention is configured)
        // would have silently decoupled actual cleanup timing from it
        // entirely. Comparing directly against `now` is correct: a row's
        // own anon_expires_at is already the moment it should go.
        const cutoff = new Date().toISOString()
        const { data: expired, error } = await supabase
          .from('scans')
          .select('id, resume_path')
          .is('user_id', null)
          .lt('anon_expires_at', cutoff)
        if (error) { console.error('Anon cleanup query:', error.message); return }

        for (const s of expired) {
          if (s.resume_path) {
            await env.RESUMES_BUCKET.delete(s.resume_path).catch(() => {})
          }
        }
        if (expired.length > 0) {
          const ids = expired.map(s => s.id)
          await supabase.from('scans').delete().in('id', ids)
          console.log(`Cleaned ${expired.length} expired anonymous scans`)
        }

        // Also recover stuck SCANNING / FIX_GENERATING scans (replaces
        // the server.js startup recovery — here it runs hourly instead).
        const { data: stuck, error: stuckErr } = await supabase
          .from('scans')
          .update({ status: 'ERROR' })
          .in('status', ['SCANNING', 'FIX_GENERATING'])
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
export default {
  fetch: app.fetch,
  // One cron trigger, three independent jobs.
  scheduled: (event, env, ctx) => {
    scheduled(event, env, ctx)
    reconcileSweep(event, env, ctx)
    return pendingSweep(event, env, ctx)
  },
  queue,
}
