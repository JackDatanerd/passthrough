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
| Node.js 20 LTS | Local development only |

---

## 2. Supabase Setup

1. Create a new Supabase project at supabase.com.

2. In the SQL Editor, run **both** migration files in order:
   ```sql
   -- paste contents of supabase/migrations/0001_init.sql
   -- paste contents of supabase/migrations/0002_helpers.sql
   ```

3. Note your project's:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **service_role key** (Settings → API → service_role — keep this secret)

4. Seed demo data:
   ```bash
   SUPABASE_URL=https://xxxx.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
   FRONTEND_URL=https://passthrough.dev \
   node supabase/seed.js
   ```

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
wrangler secret put PAYSTACK_PUBLIC_KEY
wrangler secret put RESEND_API_KEY
```

For `JWT_SECRET`, generate a strong value:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Deploy

```bash
npm run deploy
```

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
Then redeploy: `npm run deploy`

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
   | `VITE_API_URL` | `https://api.passthrough.dev` |
   | `API_URL`      | `https://api.passthrough.dev` |

   Both point at the same Worker. `VITE_API_URL` is baked into the client
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

---

## 8. Go-Live Checklist

### Secrets
- [ ] All 7 secrets set via `wrangler secret put`
- [ ] `JWT_SECRET` is at least 32 random chars
- [ ] `PAYSTACK_SECRET_KEY` is `sk_live_...` (not `sk_test_...`)

### wrangler.toml [vars]
- [ ] `FRONTEND_URL=https://passthrough.dev`
- [ ] `PAYSTACK_CALLBACK_URL=https://passthrough.dev/payment/success`
- [ ] KV namespace `id` is filled in (not placeholder text)

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
- [ ] Verification page `/v/DEMO01` loads
- [ ] Password reset email → link works

### Seed passwords
- [ ] `admin@passthrough.dev` password changed
- [ ] `demo@passthrough.dev` password changed or account deleted

---

## 9. Monitoring & Logs

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

`@cloudflare/puppeteer` with `env.BROWSER` works in production. In local
dev with `wrangler dev`, Browser Rendering launches a local Chromium.
If it's unavailable, PDF generation fails gracefully (DOCX still delivered —
see the try/catch in scan.controller.js's `generateFix`/`generateBadge`).

### Supabase "relation does not exist" error

The migration SQL hasn't been run yet. Run both files in order via the
Supabase SQL Editor: `0001_init.sql` then `0002_helpers.sql`.

### KV rate limiter letting requests through

KV is eventually consistent — see the `rateLimiter.js` caveat comment.
Under a concurrent burst, a few extra requests may slip through at the
boundary. This is expected and acceptable for abuse mitigation. Upgrade
to a Durable Object counter if precise enforcement is required.

### Paystack webhook 401 errors

- Confirm `PAYSTACK_SECRET_KEY` secret is set on the deployed Worker
  (not just in `.dev.vars`)
- Confirm the webhook URL is registered to the deployed Worker URL,
  not a previous iteration
- Run `wrangler tail` while triggering a test event to see the raw request

### `increment_verification_views` function not found

Run `supabase/migrations/0002_helpers.sql` in the Supabase SQL Editor.

---

*For support: support@passthrough.dev*
