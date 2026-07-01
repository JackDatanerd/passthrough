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

const { getSupabase } = require('./config/supabase')
const { scanRowToCamel } = require('./lib/mappers')

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
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
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

// ── EXPORT ────────────────────────────────────────────────────────────────────
// Both `fetch` (HTTP requests) and `scheduled` (cron) must be on the same
// default export for Wrangler to wire them up correctly.
export default {
  fetch: app.fetch,
  scheduled,
}
