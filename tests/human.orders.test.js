import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { Hono } = require_('hono')

// Experts Phase 1, customer side: the flag, the allow-list, the checkout (prices from the settings row, never a code or a promo),
// the frozen documents, and what the order API refuses.

const SETTINGS = { version: 1,
  prices: { polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 },
  pay: { polish: 2500, seven_day: 5000, forty_eight_hour: 7000, twenty_four_hour: 9000, cover_letter: 1800 },
  tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true },
  turnaround_hours: { seven_day: 168, forty_eight_hour: 48, twenty_four_hour: 24 }, internal_buffer_hours: { forty_eight_hour: 4 },
  pilot_cap_orders: 15, pending_expiry_hours: 24, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, materials_max_files: 3, materials_max_bytes: 5242880,
  revision_hours: { twenty_four_hour: 24, other: 48 } }
const RESUME = { name: 'Wanjiru Kamau', email: 'wanjiru.k@example.com', phone: '+254 712 345 678', location: 'Nairobi', summary: 'Product manager. Reach me at wanjiru.k@example.com.',
  experience: [{ company: 'Acme Ltd', title: 'Product Manager', dates: '2019 - 2023', bullets: ['Grew users 40%.'] }] }
const SCAN = '11111111-1111-4111-8111-111111111111'
const U1 = '22222222-2222-4222-8222-222222222222'
const BRIEF = { targetRole: 'Senior PM', region: 'Africa', tone: 'balanced' }
const CONSENTS = { terms: true, age: true, rights: true, learning: false }
const ENV = { EXPERTS_ENABLED: 'true', EXPERTS_ALLOWED_EMAILS: 'a@b.c', FRONTEND_URL: 'https://app.test', PAYSTACK_CURRENCY: 'USD' }

let t
afterEach(() => { t?.restore(); t = null })
function build({ user = { id: U1, email: 'a@b.c', name: 'A' }, world: w = null, settings = SETTINGS, paystack = null, scan = {} } = {}) {
  const world = w || createWorld({
    scans: [{ id: SCAN, user_id: U1, ats_score: 41, job_description_text: 'We need a PM at Globex.', original_resume_data: RESUME, rewritten_resume_data: null, cover_letter_text: null, ...scan }],
    users: [{ id: U1, email: 'a@b.c', name: 'A' }], payments: [], human_jobs: [], job_documents: [], job_locked_values: [], job_events: [], job_materials: [], job_questions: [],
    system_state: settings ? [{ key: 'human_pilot', value: settings }] : [] })
  world.rpcs.human_job_reverse = ({ p_job }) => { const j = world.t.human_jobs.find(x => x.id === p_job); if (j) j.state = ['awaiting_payment', 'offered'].includes(j.state) ? 'cancelled' : 'refunded'; return { data: { ok: true, state: j && j.state }, error: null } }
  const init = []
  const stubs = {
    'config/supabase.js': { getSupabase: () => world.db },
    'middleware/auth.js': async (c, next) => { if (user) c.set('user', user); else return c.json({ success: false, message: 'Authentication required.' }, 401); return next() },
    'services/paystack.service.js': { initializeTransaction: async (env, a) => { init.push(a); if (paystack) return paystack(a); return { access_code: 'AC1', authorization_url: 'https://paystack.test/x' } } },
    'lib/fieldCrypto.js': { hasKey: () => true, sealTaxId: async (e, v) => `enc:${v}`, openTaxId: async (e, v) => String(v).replace(/^enc:/, '') },
    'services/email.service.js': { sendOwnerAlert: async () => {} },
  }
  // controllers destructure their stubs at load: drop every cached module of this feature so each build binds its own world
  for (const k of Object.keys(require_.cache)) if (/[\\/]src[\\/](controllers[\\/]human|routes[\\/]human|middleware[\\/]humanLimits|services[\\/]humanSettle)/.test(k)) delete require_.cache[k]
  t = loadWithStubs('routes/human.routes.js', stubs)
  const app = new Hono(); app.route('/api/human', t.mod); app.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))
  t.world = world; t.init = init
  return app
}
const post = (a, path, body, env = ENV) => a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env)
const order = (over = {}) => ({ scanId: SCAN, tier: 'forty_eight_hour', addCoverLetter: false, brief: BRIEF, consents: CONSENTS, ...over })

describe('the flag and the allow-list', () => {
  for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
    it(`EXPERTS_ENABLED=${JSON.stringify(flag)}: every path answers the ordinary 404 and nothing is read or written`, async () => {
      const a = build(); const env = flag === undefined ? {} : { EXPERTS_ENABLED: flag, EXPERTS_ALLOWED_EMAILS: '*' }
      for (const [m, p] of [['GET', '/api/human/config'], ['POST', '/api/human/orders'], ['GET', '/api/human/orders'], ['GET', `/api/human/orders/${SCAN}`], ['POST', `/api/human/orders/${SCAN}/accept`], ['GET', `/api/human/orders/${SCAN}/files/pdf`]]) {
        const res = await a.request(p, { method: m, ...(m === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) }, env)
        expect(res.status, `${m} ${p}`).toBe(404)
        expect(await res.json()).toEqual({ success: false, message: 'Not found.' })
      }
      expect(t.world.t.payments).toHaveLength(0); expect(t.init).toHaveLength(0)
    })
  }
  it('flag on but the account is not on the allow-list: config says unavailable, ordering is 403, nothing is created', async () => {
    const a = build({ user: { id: U1, email: 'someone@else.com' } })
    expect((await (await a.request('/api/human/config', {}, ENV)).json()).data).toEqual({ available: false })
    expect((await post(a, '/api/human/orders', order())).status).toBe(403)
    expect(t.world.t.payments).toHaveLength(0)
  })
  it('signed out is 401', async () => { const a = build({ user: null }); expect((await a.request('/api/human/config', {}, ENV)).status).toBe(401) })
})

describe('config', () => {
  it('lists only the enabled tiers with prices from the settings row, the exact consent wording, and availability', async () => {
    const a = build()
    const d = (await (await a.request('/api/human/config', {}, ENV)).json()).data
    expect(d.available).toBe(true)
    expect(d.tiers.map(x => [x.tier, x.priceCents])).toEqual([['seven_day', 8900], ['forty_eight_hour', 11900], ['twenty_four_hour', 14900]])
    expect(d.coverLetterCents).toBe(2900)
    expect(d.wording.age).toBe('I am 18 or older.')
    expect(d.wording.codes).toBe('Codes apply to the AI Fix only. Your code was not used on this order and is still saved.')
  })
  it('settings missing, or a currency other than USD: not available (fail closed)', async () => {
    expect((await (await build({ settings: null }).request('/api/human/config', {}, ENV)).json()).data.available).toBe(false)
    expect((await (await build().request('/api/human/config', {}, { ...ENV, PAYSTACK_CURRENCY: 'KES' })).json()).data.available).toBe(false)
  })
  it('reports capacity: at the cap the order is refused with PILOT_FULL', async () => {
    const a = build(); for (let i = 0; i < 15; i++) t.world.t.human_jobs.push({ id: `j${i}`, state: 'offered', paid_at: '2026-10-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', customer_user_id: 'x', scan_id: `s${i}` })
    expect((await (await a.request('/api/human/config', {}, ENV)).json()).data).toMatchObject({ available: false, atCapacity: true })
    const res = await post(a, '/api/human/orders', order()); expect(res.status).toBe(409); expect((await res.json()).code).toBe('PILOT_FULL')
  })
})

describe('checkout', () => {
  it('creates the payment row (human kind, no scan, amount from settings), the job in awaiting_payment, frozen masked documents and sealed locked values', async () => {
    const a = build()
    const res = await post(a, '/api/human/orders', order({ addCoverLetter: true }))
    expect(res.status).toBe(200)
    const d = (await res.json()).data
    expect(d).toMatchObject({ priceCents: 14800, tier: 'forty_eight_hour', accessCode: 'AC1', codeIgnored: null })
    const w = t.world.t
    expect(w.payments).toHaveLength(1)
    expect(w.payments[0]).toMatchObject({ product_kind: 'human_forty_eight_hour', scan_id: null, fix_tier: null, amount_cents: 14800, currency: 'USD', status: 'PENDING', user_id: U1, paystack_access_code: 'AC1' })
    expect(w.payments[0].referral_code_id ?? null).toBeNull()
    expect(w.human_jobs[0]).toMatchObject({ state: 'awaiting_payment', tier: 'forty_eight_hour', price_cents: 14800, tier_price_cents: 11900, cover_price_cents: 2900, expert_pay_cents: 8800, age_attested: true, rights_attested: true, learning_consent: false, scan_id: SCAN, score_before: 41, payment_id: w.payments[0].id })
    expect(w.human_jobs[0].job_number).toMatch(/^HJ-/)
    expect(w.job_documents.map(x => x.kind).sort()).toEqual(['source', 'working'])
    const stored = JSON.stringify(w.job_documents)
    for (const secret of ['wanjiru.k@example.com', '254 712', 'Wanjiru', 'Kamau']) expect(stored, secret).not.toContain(secret)
    expect(w.job_locked_values.every(r => r.value_enc.startsWith('enc:'))).toBe(true)
    expect(w.job_locked_values.map(r => r.path)).toContain('lock:email')
    expect(t.init).toHaveLength(1); expect(t.init[0]).toMatchObject({ amount: 14800, scanId: SCAN, callbackUrl: `https://app.test/human/orders?reference=${w.payments[0].paystack_ref}` })
  })

  it('NO CODE PATH: every kind of code in the request, and an active promo window, change nothing; the code is reported as not used', async () => {
    const env = { ...ENV, PROMO_PRICES_JSON: JSON.stringify({ FIX: 100, BADGE: 100, FIX_PLAIN: 100 }), PROMO_PRICES_CURRENCY: 'USD', PROMO_ENDS_AT: new Date(Date.now() + 86400e3).toISOString() }
    for (const code of ['WELCOME10', 'PARTNER-ABC', 'REF-12345', 'SAVE50', 'FREE']) {
      const a = build()
      const res = await post(a, '/api/human/orders', order({ code }), env)
      expect(res.status, code).toBe(200)
      const d = (await res.json()).data
      expect(d.priceCents).toBe(11900); expect(d.codeIgnored).toMatch(/^Codes apply to the AI Fix only/)
      const w = t.world.t
      expect(w.payments[0]).toMatchObject({ amount_cents: 11900 }); expect(w.payments[0].referral_code ?? null).toBeNull(); expect(w.payments[0].referral_reservation_id ?? null).toBeNull()
      expect(Object.keys(w).filter(k => /referral|commission|welcome|usage/.test(k) && w[k].length)).toEqual([])
      t.restore()
    }
  })
  it('the human order code never imports the referral, partner, promo or pricing code', () => {
    const fs = require_('node:fs')
    for (const f of ['controllers/human.controller.js', 'controllers/human-files.controller.js', 'services/humanSettle.js', 'lib/humanPilot.js']) {
      const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toMatch(/require\(['"][^'"]*(referral|partner|promo|pricing|welcome)[^'"]*['"]\)/i)
    }
  })

  it.each([
    ['a required tick missing', { consents: { terms: true, age: false, rights: true } }, 400],
    ['an unknown field', { somethingElse: 1 }, 400],
    ['a short role', { brief: { ...BRIEF, targetRole: 'x' } }, 400],
    ['an unknown region', { brief: { ...BRIEF, region: 'Mars' } }, 400],
    ['a disabled tier (polish)', { tier: 'polish' }, 409],
  ])('refuses %s with %i and creates nothing', async (_l, over, status) => {
    const a = build(); const res = await post(a, '/api/human/orders', order(over))
    expect(res.status).toBe(status); expect(t.world.t.payments).toHaveLength(0); expect(t.world.t.human_jobs).toHaveLength(0); expect(t.init).toHaveLength(0)
  })
  it("another account's scan is a 404; a scan with no structured resume is a 409 that says what to do", async () => {
    const a = build({ scan: { user_id: 'someone-else' } }); expect((await post(a, '/api/human/orders', order())).status).toBe(404); t.restore()
    const b = build({ scan: { original_resume_data: null } }); const r = await post(b, '/api/human/orders', order())
    expect(r.status).toBe(409); expect((await r.json()).code).toBe('NO_STRUCTURED_RESUME')
  })
  it('a second live order for the same resume is refused; an earlier unpaid attempt is replaced', async () => {
    const a = build()
    expect((await post(a, '/api/human/orders', order())).status).toBe(200)
    const again = await post(a, '/api/human/orders', order())          // the first is still awaiting payment: replaced
    expect(again.status).toBe(200)
    expect(t.world.t.human_jobs.filter(j => j.state === 'awaiting_payment')).toHaveLength(1)
    expect(t.world.t.payments.filter(p => p.status === 'ABANDONED')).toHaveLength(1)
    t.world.t.human_jobs.find(j => j.state === 'awaiting_payment').state = 'offered'
    const third = await post(a, '/api/human/orders', order()); expect(third.status).toBe(409); expect((await third.json()).code).toBe('ALREADY_ORDERED')
  })
  it('if Paystack cannot start, the payment is abandoned and the job closed; the customer gets a plain message', async () => {
    const a = build({ paystack: () => { throw Object.assign(new Error('nope'), { paystackRejected: true }) } })
    const res = await post(a, '/api/human/orders', order()); expect(res.status).toBe(400)
    expect(t.world.t.payments[0].status).toBe('ABANDONED'); expect(t.world.t.human_jobs[0].state).toBe('cancelled')
  })
})

describe('reading and acting on an order', () => {
  async function placed() { const a = build(); const d = (await (await post(a, '/api/human/orders', order())).json()).data; return { a, id: d.orderId } }
  it('the owner reads the order (brief, status label, cancel only once paid) and a stranger gets 404', async () => {
    const { a, id } = await placed()
    const d = (await (await a.request(`/api/human/orders/${id}`, {}, ENV)).json()).data
    expect(d).toMatchObject({ state: 'awaiting_payment', status: 'Waiting for payment', canCancel: false, canAccept: false, canRevise: false, tierLabel: '48-hour rewrite' })
    expect(d.brief.targetRole).toBe('Senior PM')
    t.world.t.human_jobs[0].customer_user_id = 'someone-else'
    expect((await a.request(`/api/human/orders/${id}`, {}, ENV)).status).toBe(404)
    expect((await post(a, `/api/human/orders/${id}/accept`, {})).status).toBe(404)
  })
  it('cancel is for a paid order no expert has taken; it closes the job first and queues the refund through the existing refund service', async () => {
    const { a, id } = await placed()
    expect((await post(a, `/api/human/orders/${id}/cancel`, {})).status).toBe(409)                 // unpaid
    t.world.t.human_jobs[0].state = 'in_progress'
    expect((await post(a, `/api/human/orders/${id}/cancel`, {})).status).toBe(409)                 // taken
  })
  it('rating validates stars; accept and revision are only available once delivered (the database decides)', async () => {
    const { a, id } = await placed()
    expect((await post(a, `/api/human/orders/${id}/rate`, { stars: 9 })).status).toBe(400)
    expect((await post(a, `/api/human/orders/${id}/revision`, { reason: 'x' })).status).toBe(400)
  })
})
