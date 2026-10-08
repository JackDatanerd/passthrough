# Passthrough — Deployment Guide (Cloudflare Workers)

This guide supersedes the previous VPS/Nginx/PM2 deployment guide.
There is no server, no SSH, no `apt-get`, and no PM2. The entire
backend runs as a Cloudflare Worker.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Supabase Setup](#2-supabase-setup)
3. [Cloudflare Setup (R2, KV, Browser Rendering)](#3-cloudflare-setup)
4. [Local Development](#4-local-development)
5. [Deploy the Worker](#5-deploy-the-worker)
6. [Deploy the Frontend (Cloudflare Pages)](#6-deploy-the-frontend)
7. [Register the Paystack Webhook](#7-register-the-paystack-webhook)
8. [Go-Live Checklist](#8-go-live-checklist)
9. [Monitoring & Logs](#9-monitoring--logs)
10. [Updating](#10-updating)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Prerequisites

| Item | Notes |
|------|-------|
| Cloudflare account (Free or paid) | Browser Rendering requires Workers Paid plan ($5/mo) |
| Supabase project | Free tier is fine to start |
| Paystack account (business verified) | USD support requires verification |
| Anthropic API key | Pay-as-you-go |
| Resend account | Verify your sending domain before production |
| Node.js 20 LTS or newer (CI runs 22) | Local development only |

---

## 2. Supabase Setup

1. Create a new Supabase project at supabase.com.

2. In the SQL Editor, run **every** file in `supabase/migrations/`, **in
   filename order** (the leading number is the order — `0001_...` before
   `0002_...` before `0003_...`, and so on). This list only ever grows, so
   don't copy a fixed count from this doc — `ls supabase/migrations/` (or
   just look at the folder) and run whatever's actually there, in order:
   ```sql
   -- paste contents of supabase/migrations/0001_init.sql
   -- paste contents of supabase/migrations/0002_helpers.sql
   -- paste contents of supabase/migrations/0003_brain_dump_and_profiles.sql
   -- paste contents of supabase/migrations/0004_fix_ats_score.sql
   -- paste contents of supabase/migrations/0005_fix_retries_and_credits.sql
   -- paste contents of supabase/migrations/0006_redeem_fix_credit.sql
   -- paste contents of supabase/migrations/0007_verify_document_visibility.sql
   -- paste contents of supabase/migrations/0008_atomic_scan_quota.sql
   -- paste contents of supabase/migrations/0009_atomic_fix_retry.sql
   -- paste contents of supabase/migrations/0010_payments_fix_tier.sql
   -- paste contents of supabase/migrations/0011_partners_and_payouts.sql
   -- paste contents of supabase/migrations/0012_referral_pricing_and_commission_ledger.sql
   -- paste contents of supabase/migrations/0013_employer_leads_dedup.sql
   -- paste contents of supabase/migrations/0014_enable_rls.sql
   -- paste contents of supabase/migrations/0015_definer_hardening_and_score_checks.sql
   -- ...and every migration after 0015 too, in filename order — this list has
   -- fallen behind the folder before (once as far back as 0015 itself, caught
   -- during the Section 5 fixing-time pass); `ls supabase/migrations/` is the
   -- source of truth, not this file.
   -- ...and any files added after this doc was last updated
   ```
   AUDIT FIX (Section 9): this used to say to run only `0001_init.sql` and
   `0002_helpers.sql` — accurate when this doc was first written, silently
   wrong from the moment `0003_...` shipped. A fresh deploy following the
   old instructions literally would be missing brain-dump/profiles, fix
   retries/credits, verification-visibility toggles, every atomic RPC after
   0002, payment tier binding, partners/payouts, referral pricing, and RLS
   — i.e. almost everything built after the MVP.

3. Note your project's:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **service_role key** (Settings → API → service_role — keep this secret)

4. **Production: do NOT seed.** `supabase/seed.js` creates an ADMIN account
   and a fake "Passthrough Verified" page (`/v/DEMO01`) — fine for a
   development or staging project, a forged credential on a real domain.
   It refuses to run unless you opt in, and it never contains passwords
   (the repository is public). For a dev/staging project only:
   ```bash
   SEED_ENV=development \
   SEED_ADMIN_PASSWORD='at-least-12-characters' \   # optional: random one is printed once if unset
   SUPABASE_URL=https://xxxx.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
   FRONTEND_URL=http://localhost:3000 \
   node supabase/seed.js
   ```
   In production, create your admin by registering normally and then setting
   `role = 'ADMIN'` on that row in the SQL editor.

---

## 3. Cloudflare Setup

### Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

### Create the R2 bucket

```bash
wrangler r2 bucket create passthrough-resumes
```

### Create the KV namespace

```bash
wrangler kv namespace create passthrough-ratelimit
```

Paste the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`:
```toml
id = "paste-id-here"
```

### Durable Object (rate limits)

Nothing to create by hand: the `[[durable_objects.bindings]]` and
`[[migrations]]` blocks in `wrangler.toml` declare `RateLimiterDO`, and the
first deploy applies the migration. Rate limits and the login lockout count
inside this object, where a read-modify-write is atomic. Without the binding
they fall back to the KV counters (best-effort: a burst of parallel requests
can overrun them) and the Worker logs a configuration warning on start-up.

### Enable Browser Rendering

Enabled automatically on Workers Paid plan. No creation step — the
`[browser]` binding in `wrangler.toml` is all that's needed.

---

## 4. Local Development

```bash
# Install dependencies
npm install

# Copy the example dev vars file
cp .dev.vars.example .dev.vars

# Fill in all values in .dev.vars (gitignored — never commit this file)
nano .dev.vars

# Start the Worker locally
npm run dev

# In a separate terminal, start the frontend
cd frontend && npm install && npm run dev
```

`wrangler dev` starts the Worker on port 4000. Vite's proxy routes
`/api` requests there. Browser Rendering runs locally via a simulated
binding (does not hit the real Cloudflare service in dev).

---

## 5. Deploy the Worker

### Set production secrets

Run each of these once — secrets are encrypted at rest and never stored in `wrangler.toml`:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put JWT_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put PAYSTACK_SECRET_KEY
wrangler secret put RESEND_API_KEY
```

<!-- AUDIT FIX (Section 9/10 pass): this list previously included
     `wrangler secret put PAYSTACK_PUBLIC_KEY` and counted "7 secrets" below.
     Nothing in src/ or frontend/src/ reads PAYSTACK_PUBLIC_KEY — the
     checkout flow (ScanResult.jsx) opens the Paystack popup with
     `popup.resumeTransaction(access_code, ...)`, using only the access_code
     the backend already returned from /payments/initialize; no public key
     is needed client-side with that flow. Left over from an earlier
     implementation, presumably. Dropped rather than kept as a harmless
     no-op instruction, since an operator following this list has no way to
     tell "unused" apart from "I forgot to wire this up" — a stale
     instruction here costs real time chasing a key that does nothing. -->

For `JWT_SECRET`, generate a strong value:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Optional secrets

None of these is required for a normal deploy — each defaults to "off" (or to a
sensible built-in) when unset, which is the correct state for a real production
launch:

```bash
# Restricts /api/webhooks/paystack to Paystack's published outbound IP
# ranges. Optional defense-in-depth on top of the HMAC signature check
# webhooks.controller.js already does; unset means IP is not checked.
#
# Comma-separated. Paystack's documented webhook source IPs (verify against
# https://paystack.com/docs/payments/webhooks/ before pinning — they can change):
#   52.31.139.75,52.49.173.169,52.214.14.220
wrangler secret put PAYSTACK_WEBHOOK_IPS

# Shared secret between the Worker and the /v/:code Pages Function. When set on
# BOTH sides (same value; on Pages it is an environment variable named
# VERIFY_PREVIEW_KEY), the Function's link-preview fetch skips the per-IP verify
# limits and never counts a crawler's bad-URL probes as lookup "misses" against
# Cloudflare's shared egress IPs. Unset = previews are limited like any client.
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
wrangler secret put VERIFY_PREVIEW_KEY

# Minimum partner payout, in cents (e.g. 2000 = $20.00). Unset or 0 = no minimum.
# Below it, a partner's payable commission is shown as "carried forward" instead of
# "ready to pay", and a cycle-scoped payout is refused (an ad hoc payout is the
# deliberate override). Can also be set as a plain [vars] entry in wrangler.toml.
wrangler secret put COMMISSION_MIN_PAYOUT_CENTS

# Commission hold window, in days (e.g. 7). Unset or 0 = no hold. A commission younger
# than this is shown as "held" and left out of "ready to pay" and of any payout (a refund
# that lands during the hold voids the sale together with its commission, and a commission
# on a DISPUTED payment is held regardless of age). Also settable as a plain [vars] entry.
wrangler secret put COMMISSION_HOLD_DAYS

# PARTNER LINKS (migration 0055): every partner has TWO bearer tokens. The READ-ONLY
# dashboard token is what conversion / reversal / code emails carry; the payout-details
# token (which can change where payouts go) is only ever mailed on its own, on request
# (POST /api/partners/request-payout-link, rate limited), or copied by an admin from the
# partner page. Apply supabase/migrations/0055_partners_round4.sql BEFORE deploying the
# Worker that reads dashboard_token / payouts.internal_note / partner_applications.review_note.

# PROFILE & DASHBOARD (migration 0056): saving a profile from a scan now goes through the
# save_profile_from_scan() function, which refuses to overwrite a profile the person has
# corrected by hand unless they confirm. Apply supabase/migrations/0056_profile_dashboard_round6.sql
# BEFORE deploying the Worker — without it POST /api/profile/save fails.

# Lets specific IPs (comma-separated) skip every rate limiter entirely —
# for load-testing or manual QA against production limits. Unset = no
# bypass = normal behavior for everyone, which is the fail-safe default.
# Turn it OFF again before real users arrive:
#   wrangler secret delete RATE_LIMIT_BYPASS_IPS
wrangler secret put RATE_LIMIT_BYPASS_IPS

# Cloudflare Turnstile bot challenge on the public forms that email an address a
# stranger typed: the employer-lead form, sign-up and forgot-password (login is
# not challenged — it emails no one, and the per-account lockout covers it). Off by
# default. To turn it on set BOTH halves: this secret on the Worker, and
# VITE_TURNSTILE_SITE_KEY on Pages (see section 6) followed by a frontend
# rebuild — the widget only renders when the site key was baked into the
# bundle, and the Worker only demands a token when this secret is set, so
# enabling one half alone is harmless. Create the widget under Cloudflare
# dashboard -> Turnstile. If Cloudflare itself is unreachable the form still
# accepts submissions (an outage must not lose leads or lock people out).
wrangler secret put TURNSTILE_SECRET_KEY

# Optional. The public origin the Worker is reached at (no path), used to build
# the one-click List-Unsubscribe URL in employer-lead acknowledgement emails.
# Unset = taken from the incoming request, which is correct for the normal
# single-hostname setup; set it only if requests reach the Worker under a
# different hostname than the one mail clients should call back.
#   https://api.passthrough.dev
wrangler secret put API_ORIGIN

# Extra browser origins allowed by CORS in addition to FRONTEND_URL (comma-separated,
# no trailing slashes) — the www variant, a staging site, a Pages preview.
#   https://www.passthrough.dev,https://staging.passthrough.dev
wrangler secret put CORS_EXTRA_ORIGINS

# Raise/lower the per-request Supabase timeout (default 25000 ms).
#   (a plain [vars] entry in wrangler.toml is fine for this one)
# SUPABASE_TIMEOUT_MS = "25000"

# Other optional [vars]/secrets read by the code: SCAN_IP_DAILY_CAP (free scans per IP per day;
# 0 disables the cap), PWNED_PASSWORDS_CHECK ("off" turns off the breached-password
# check), RATE_LIMIT_BYPASS_IPS (comma-separated; ignored in production).
```

### Deploy

Deploy from CI / Linux, never with a local `wrangler deploy` on Windows (it
mangles secrets and can crash). Before any deploy, `npm run predeploy` (lint
+ backend tests) must be green; CI also bundles the Worker with
`wrangler deploy --dry-run` so a bundling failure shows up on the pull request
rather than in production. The deploy itself is the plain
`npx wrangler deploy` run by your CI/CD job (needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` there); this repository does not define that job.

Wrangler bundles `src/index.js` (ESM entry) with all CommonJS dependencies
via esbuild and uploads the bundle. No build step needed — wrangler handles it.

Your Worker is now live at `https://passthrough-api.YOUR_SUBDOMAIN.workers.dev`
(or your custom domain if configured in the Cloudflare dashboard).

### Set a custom domain (recommended)

In Cloudflare Dashboard → Workers & Pages → passthrough-api → Settings →
Custom Domains → Add custom domain → `api.passthrough.dev`.

Update `wrangler.toml` `[vars]` if you haven't already:
```toml
FRONTEND_URL          = "https://passthrough.dev"
PAYSTACK_CALLBACK_URL = "https://passthrough.dev/payment/success"
```
Then redeploy (CI).

**Duplicate-charge auto-refund (Payments & Pricing round 6).** `AUTO_REFUND_DUPLICATES` (default on, set in
`wrangler.toml` `[vars]`) refunds a second successful payment for an already-delivered scan in full, using
the same Paystack refund guards as the admin Refund button. Set it to `"false"` to return to alert-only.
Migration 0048 (`payments.refund_claimed_at`) must be applied — without it refunds still work but lose the
concurrency lock (a loud log line says so).

---

## 6. Deploy the Frontend (Cloudflare Pages)

1. Push your repo to GitHub.
2. Cloudflare Dashboard → Pages → Create a project → Connect to Git.
3. Configure:

   | Setting | Value |
   |---------|-------|
   | Framework preset | None |
   | Build command | `cd frontend && npm install && npm run build` |
   | Build output directory | `frontend/dist` |
   | Root directory | `/` |

4. Add environment variables:

   | Variable | Value |
   |----------|-------|
   | `VITE_API_URL` | `https://api.passthrough.dev/api` |
   | `API_URL`      | `https://api.passthrough.dev/api` |
   | `VERIFY_PREVIEW_KEY` | *(optional)* same value as the Worker secret of that name — see "Optional secrets" |
   | `VITE_TURNSTILE_SITE_KEY` | *(optional)* Turnstile site key; pair with the Worker's `TURNSTILE_SECRET_KEY`. Baked in at build time. Cloudflare's always-passes test key for trying it: `1x00000000000000000000AA` (secret `1x0000000000000000000000000000000AA`) |

   Both point at the same Worker, and **both must include the `/api` suffix** —
   every Worker route is mounted under `/api` (e.g. `/api/auth/login`). Both
   consumers now append `/api` themselves if it is missing
   (`frontend/src/lib/apiUrl.js` and `frontend/functions/v/[code].js`), so the
   bare host also works, but writing the full URL here avoids any doubt. (This
   table previously said `https://api.passthrough.dev` with no suffix, which on
   its own would have sent every production request to a 404, and silently
   broken the share-preview Function.) `VITE_API_URL` is baked into the client
   bundle at build time and used by the React app in the browser.
   `API_URL` is read server-side, at request time, by
   `frontend/functions/v/[code].js` — the Pages Function that injects
   per-candidate Open Graph/Twitter Card tags into `/v/:code` so a shared
   verification link unfurls with the actual candidate/score instead of
   the generic homepage preview. Without `API_URL` set, that Function
   fails open and just serves the normal static page — nothing breaks,
   the personalized share preview just won't appear.

5. Save and Deploy.

Every push to `main` triggers an automatic rebuild and deploy.

---

## 7. Register the Paystack Webhook

1. Paystack Dashboard → Settings → API Keys & Webhooks.
2. Webhook URL:
   ```
   https://api.passthrough.dev/api/webhooks/paystack
   ```
3. Save. Test with "Send test event" and check logs:
   ```bash
   wrangler tail
   ```
4. There is nothing to subscribe to: Paystack sends every event type to the one URL,
   and anything this app doesn't act on is recorded and ignored. The ones it acts on
   are `charge.success`, `refund.processed`, `refund.failed`, `refund.needs-attention`,
   `charge.dispute.create`, `charge.dispute.remind` and `charge.dispute.resolve`.
   (There is no `charge.failed` event — earlier versions of this doc listed one.)
   `refund.needs-attention` matters: Paystack stalls that refund until you supply
   the customer's bank details, and the app emails you when it arrives.
5. Every verified event is recorded in the `webhook_events` table and is visible —
   with a **Replay** button for HELD / FAILED / IGNORED ones — under
   **Admin → Webhooks** (search by reference or event type, view the stored payload).
6. Recovery you don't have to do by hand (hourly, from the cron): FAILED or stuck events
   are re-run up to 8 times and you're emailed once if they stay stuck; a HELD event
   waiting over a day is escalated; recent paid payments are checked against Paystack
   so a refund whose webhook never arrived is still reversed (partial refunds are only
   reported); a receipt whose send was cancelled is re-sent.
7. **Migration `0036_verify_webhooks_round3.sql`** adds what the above needs (webhook
   inbox notes, replay attribution, refund-reconciliation and receipt columns,
   "removed page" tombstones, look-up-by-file indexes). The app keeps working without
   it, but those features stay off until it is applied.
8. One-off, after 0036: pages issued before PDF fingerprinting existed show integrity
   "partly checked". To fingerprint their PDFs as stored today (trust-on-first-use), call
   `POST /api/admin/verification/backfill-pdf-hashes` as an admin, repeatedly until it
   reports `remaining: false`.

> **Upgrading an existing deployment:** apply migration
> `0033_receipts_and_ban_revocation.sql` **before** deploying this version. The
> receipt guard falls back to the old behaviour without it, but banning an
> account (which now takes its public verification pages down) needs the new
> `BAN` revoke reason and will fail its constraint check until it is applied.
> The hourly cron also now runs the failed-fix sweep, so paid scans stuck at
> `ERROR` from the last 7 days will be re-queued automatically (up to 10 per run).

---

### Register the Resend webhook (bounces and spam complaints)

Employer-lead emails go to addresses strangers typed into a public form, from the same domain as
password resets. A spam complaint or a permanent bounce must therefore stop all further employer
mail to that address — the endpoint below does that automatically (hash recorded, lead removed,
mail history cleared; same result as the person clicking Remove).

1. In Resend: **Webhooks → Add endpoint**, URL `https://<your-api-domain>/api/webhooks/resend`,
   events **`email.bounced`** and **`email.complained`** (other events are ignored).
2. Copy the endpoint's signing secret (`whsec_…`) and set it on the Worker:
   ```bash
   wrangler secret put RESEND_WEBHOOK_SECRET
   ```
3. Until it is set the endpoint answers 500 and logs `[CRITICAL] RESEND_WEBHOOK_SECRET is not
   configured`; Resend retries, so nothing is lost once the secret is in place.

A transient bounce, and every other event type, is acknowledged and ignored. A permanent bounce is
acted on only when the address is currently an employer lead; a complaint always suppresses it.
Each action is written to the admin audit log as `lead.auto_suppressed` (no actor, address hash only).

## 8. Go-Live Checklist

### Secrets
- [ ] All 6 required secrets set via `wrangler secret put` (SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, ANTHROPIC_API_KEY,
      PAYSTACK_SECRET_KEY, RESEND_API_KEY)
- [ ] `JWT_SECRET` is at least 32 random chars
- [ ] `PAYSTACK_SECRET_KEY` is `sk_live_...` (not `sk_test_...`)
- [ ] `RATE_LIMIT_BYPASS_IPS` is **unset** (or deleted) — if it was set for
      testing, `wrangler secret delete RATE_LIMIT_BYPASS_IPS` before real
      users arrive

### wrangler.toml [vars]
- [ ] `FRONTEND_URL=https://passthrough.dev`
- [ ] `PAYSTACK_CALLBACK_URL=https://passthrough.dev/payment/success`
- [ ] KV namespace `id` is filled in (not placeholder text)
- [ ] `PROMO_ENDS_AT` is set to your real launch-week end time, not the
      placeholder date shipped in the repo — the placeholder is a real UTC
      timestamp, not an obviously-fake one, so a deploy that skips this step
      doesn't error out; it just silently ships with the promo already
      expired (or expiring at the wrong moment) with no warning anywhere.
      Set `PROMO_ACTIVE=false` instead if you don't want a promo at launch.

### Infrastructure
- [ ] R2 bucket created: `passthrough-resumes`
- [ ] Worker deployed: `wrangler deploy` ran without errors
- [ ] Custom domain set: `api.passthrough.dev` resolves
- [ ] Frontend deployed with `VITE_API_URL` env var set
- [ ] Paystack webhook URL registered and test event received

### Functional tests
- [ ] Register → welcome + verify emails received (from Resend)
- [ ] Email verify link works
- [ ] Upload a real resume + JD → score appears in <60s
- [ ] Payment flow (test card: 4084 0840 8408 4081) → FIX_DELIVERED
- [ ] Downloaded .docx opens in Word with bullets
- [ ] A verification page for a REAL delivered scan loads
- [ ] Password reset email → link works

### Seed leftovers (must all be "none")
- [ ] No `admin@passthrough.dev` / `demo@passthrough.dev` rows in `users` (earlier versions of
      `seed.js` created them with a password that was in this public repository — if either
      exists in production, delete it or set a new password and rotate any session)
- [ ] No scan with `verification_code = 'DEMO01'` (the forged demo credential) — delete it
- [ ] `RATE_LIMIT_DO` binding present (no "binding RATE_LIMIT_DO is missing" line in the logs)

---

## 9. Monitoring & Logs

### Persisted logs

`[observability]` is enabled in `wrangler.toml`, so every `console.log` /
`console.error` and uncaught exception is kept in Workers Logs (Cloudflare
Dashboard → Workers & Pages → passthrough-api → Logs) and can be searched
after the fact; the `cf-ray` id on an error line ties it to the failing request.

### Live log tail

```bash
wrangler tail                    # all log lines
wrangler tail --format pretty    # formatted output
wrangler tail --status error     # errors only
```

### Cloudflare Analytics

Cloudflare Dashboard → Workers & Pages → passthrough-api → Metrics.
Shows request count, CPU time, errors, and status codes.

### Supabase logs

Supabase Dashboard → Logs → API (PostgREST errors), Auth, Edge Functions.

---

## 10. Updating

```bash
# Pull latest
git pull origin main

# Deploy Worker
npm run deploy

# Frontend re-deploys automatically on git push
```

Database schema changes:
- Write a new migration file: `supabase/migrations/000N_description.sql`
- Run it in the Supabase SQL Editor
- Deploy the Worker (if any code references the new columns)

---

## 11. Troubleshooting

### `export default` error during wrangler deploy

```
Your worker has no default export...
```

`src/index.js` must use `export default { fetch, scheduled }` — it's the
only ESM file in the project. Check that no edit accidentally changed it
to `module.exports`. See Section 9 of the migration patch for details.

### Browser Rendering not working locally

`@cloudflare/puppeteer` with `env.BROWSER` works in production. Whether
`wrangler dev` can run Browser Rendering locally depends on your Wrangler
version (Wrangler 3 needs `wrangler dev --remote`). When it is unavailable, PDF
generation fails gracefully (DOCX still delivered —
see the try/catch in scan.controller.js's `generateFix`/`generateBadge`).

### Supabase "relation does not exist" error

The migration SQL hasn't been run yet, or hasn't all been run — check
that every file in `supabase/migrations/` was run, in filename order (see
Section 2 above). A relation from a later migration (partners, payouts,
referral_codes, commission_ledger, etc.) failing specifically usually means
migrations were stopped partway through rather than skipped entirely.

### Rate limiter letting requests through

Rate limits and the login lockout count in the `RATE_LIMIT_DO` Durable Object,
where a burst of parallel requests cannot overrun them. If limits seem not to
bite, check the logs for `binding RATE_LIMIT_DO is missing` — without the
binding the limiter falls back to best-effort KV counters, which a parallel
burst CAN overrun (all the requests read the same count; KV also refuses a
second write to one key within a second). A `RATE_LIMIT_DO outage` /
`RATE_LIMIT_KV outage` email means the counting backend itself errored and
every limiter failed open until it recovered.

### Secret rotation

- `JWT_SECRET`: changing it signs every user out at once (no overlap window).
  Rotate in a quiet hour. Employer-lead links (confirm / remove / one-click
  unsubscribe) are signed with `JWT_SECRET` unless `LEAD_LINK_SECRET` is set, so
  rotating it with no preparation kills the "remove me" link in every email
  already delivered. Prepare once, ahead of time (see below).
- `LEAD_LINK_SECRET` (optional, recommended): a separate key for employer-lead
  links, so rotating `JWT_SECRET` no longer touches them. Setting it later is safe:
  links signed with `JWT_SECRET` keep verifying. To rotate it (or to rotate
  `JWT_SECRET` while it is unset): `wrangler secret put LEAD_LINK_SECRET_PREVIOUS`
  with the OLD value (the old `LEAD_LINK_SECRET`, or the old `JWT_SECRET`),
  `wrangler secret put LEAD_LINK_SECRET` with the new one, deploy; delete
  `LEAD_LINK_SECRET_PREVIOUS` once old emails no longer matter. Generate with the
  same command as `JWT_SECRET`.
- `RESEND_API_KEY`, `PAYSTACK_SECRET_KEY`, `ANTHROPIC_API_KEY`: `wrangler secret put`
  the new value and redeploy; no other step.

### Employer leads: purging dismissed leads

- `ARCHIVED_LEAD_PURGE_SUPPRESSES` (optional, off by default): ARCHIVED employer leads
  are deleted 90 days after their last activity. Set it to `true` (a plain `[vars]`
  entry in `wrangler.toml`) and each purged address is also put on the do-not-contact
  list (hash only) with its employer mail history cleared, so a dismissed spammer cannot
  return as a brand-new lead afterwards. Leave it unset if an archived lead might just
  have been a poor fit: the public form answers an address on that list with a silent
  success, so that person could never sign up again.

### Rolling back a bad deploy

Cloudflare Dashboard → Workers & Pages → passthrough-api → Deployments → pick
the previous version → Rollback (or `wrangler rollback`). The Durable Object
migration is additive; rolling back the code leaves it in place.

### Paystack webhook 401 errors

- Confirm `PAYSTACK_SECRET_KEY` secret is set on the deployed Worker
  (not just in `.dev.vars`)
- Confirm the webhook URL is registered to the deployed Worker URL,
  not a previous iteration
- Run `wrangler tail` while triggering a test event to see the raw request

### `increment_verification_views` function not found

Run `supabase/migrations/0002_helpers.sql` in the Supabase SQL Editor. If
other RPCs are also missing (`increment_free_fix_credits`,
`redeem_free_fix_credit`, `increment_scan_count_if_under_limit`,
`increment_fix_retry_if_available`, `increment_referral_code_usage`,
`increment_referral_code_clicks`), you're missing more than one migration —
go back to Section 2 and run everything in `supabase/migrations/`, in order.

---

*For support: support@passthrough.dev*
