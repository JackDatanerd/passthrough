import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const src = f => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

// Experts Phase 1: with EXPERTS_ENABLED off, nothing in the existing app behaves differently. The per-router 404 tests live beside each
// router (human.orders, expert, human.admin); this file proves the rest: the money paths, the sweep, the checkout call, the mounting.

describe('the existing checkout, webhook, refund and pricing code does not know the feature exists', () => {
  const TOKENS = /humanSettle|humanPilot|human_jobs|product_kind|human_job_|EXPERTS_ENABLED|expertAuth|expert_accounts/
  for (const f of ['controllers/payments.controller.js', 'controllers/webhooks.controller.js', 'services/refund.service.js', 'services/reconcile.service.js', 'controllers/scan.controller.js', 'controllers/pricing.controller.js',
    'controllers/partners.controller.js', 'services/referral.service.js', 'services/promo.service.js', 'lib/promoConfig.js', 'services/pricing.service.js', 'middleware/auth.js', 'middleware/adminOnly.js', 'lib/jwt.js'])
    it(`${f} is untouched by the pilot`, () => { if (fs.existsSync(new URL(`../src/${f}`, import.meta.url))) expect(src(f)).not.toMatch(TOKENS) })

  it('the ONLY existing file that branches on a human payment is fulfillment.service.js, in exactly two guarded places', () => {
    const s = src('services/fulfillment.service.js')
    expect(s.match(/humanSettle/g)).toHaveLength(2)
    expect(s).toMatch(/if \(row\.product_kind\) return require\('\.\/humanSettle'\)\.settleHuman/)
    expect(s).toMatch(/if \(humanKind\) await require\('\.\/humanSettle'\)\.onReversed/)
  })
})

describe('mounting', () => {
  it('index.js adds exactly two route mounts and two requires, and ONE sweep call inside the existing retention job (not an eleventh job); the routers carry their own flag gate', () => {
    const s = src('index.js')
    expect(s.match(/humanRoutes/g)).toHaveLength(2); expect(s.match(/expertRoutes/g)).toHaveLength(2)
    expect(s.match(/humanSweep\(event, env, ctx\)/g)).toHaveLength(2)      // the one call and the definition's own signature line
    expect(s).toMatch(/async function retentionSweep\(event, env, ctx\) \{[\s\S]{0,500}humanSweep\(event, env, ctx\)/)
    expect(s).not.toMatch(/^ {4}humanSweep\(event, env, ctx\)/m)           // not one of the scheduled jobs the cron comment counts
    for (const f of ['routes/human.routes.js', 'routes/expert.routes.js', 'routes/admin-human.routes.js']) expect(src(f)).toMatch(/humanEnabled\(ctx\.env\) \? next\(\) : ctx\.notFound\(\)/)
  })
})

describe('the hourly sweep', () => {
  it('is a complete no-op with the flag off: no database client is even created', async () => {
    const getSupabase = vi.fn(() => { throw new Error('must not be called') })
    const t = loadWithStubs('services/humanSweep.js', { 'config/supabase.js': { getSupabase } })
    try { for (const env of [{}, { EXPERTS_ENABLED: 'false' }, { EXPERTS_ENABLED: '1' }]) expect(await t.mod.runHumanSweep(env)).toEqual({ skipped: true }); expect(getSupabase).not.toHaveBeenCalled() } finally { t.restore() }
  })
})

describe('Paystack initialize', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('an existing caller (no callbackUrl) gets the same callback_url as before; a human order gets its own', async () => {
    const bodies = []
    vi.stubGlobal('fetch', async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: true, data: { access_code: 'A', authorization_url: 'U', reference: 'r' } }), { status: 200 }) })
    const svc = require_('../src/services/paystack.service.js')
    const env = { PAYSTACK_SECRET_KEY: 'sk_test_x', PAYSTACK_CALLBACK_URL: 'https://app.test/payment/success', PAYSTACK_CURRENCY: 'USD' }
    await svc.initializeTransaction(env, { email: 'a@b.c', amount: 100, userId: 'u', scanId: 's', fixTier: 'FIX', reference: 'r1' })
    await svc.initializeTransaction(env, { email: 'a@b.c', amount: 100, userId: 'u', scanId: 's', fixTier: 'human_x', reference: 'r2', callbackUrl: 'https://app.test/human/orders?reference=r2' })
    expect(bodies.map(b => b.callback_url)).toEqual(['https://app.test/payment/success', 'https://app.test/human/orders?reference=r2'])
  })
})

describe('the schema', () => {
  it('the new migration touches only payments.product_kind among existing tables, and the pilot is off by default (no flag, no allow-list in any config file)', () => {
    const m = fs.readdirSync(new URL('../supabase/migrations/', import.meta.url)).find(f => f.includes('experts_phase1_pilot'))
    const sql = fs.readFileSync(new URL(`../supabase/migrations/${m}`, import.meta.url), 'utf8')
    const alters = [...sql.matchAll(/alter table (\w+)/gi)].map(x => x[1].toLowerCase())
    expect([...new Set(alters)]).toEqual(['payments', 'expert_accounts', 'human_jobs', 'job_events', 'job_documents', 'job_locked_values', 'job_deliveries', 'job_questions', 'job_materials', 'expert_payouts', 'expert_earnings', 'expert_audit_log'].filter(t => alters.includes(t)))
    expect(sql).not.toMatch(/\bdrop (table|column|index|constraint|function|policy)|truncate|alter table \w+ (drop|rename|alter column)|delete from (payments|users|scans)|update (payments|users|scans) /i)
    for (const f of ['wrangler.toml', '.dev.vars.example', 'frontend/.env.example']) { const p = new URL(`../${f}`, import.meta.url); if (fs.existsSync(p)) expect(fs.readFileSync(p, 'utf8')).not.toMatch(/EXPERTS_ENABLED\s*=\s*"?true/) }
  })
})
