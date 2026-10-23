// Promotions from the admin panel (see lib/promoConfig.js for how a saved promo reaches pricing).
//
//   GET    /api/admin/promo   what is saved, what is in force right now and where it comes from (admin panel or deploy settings)
//   PUT    /api/admin/promo   save the promo: on/off, name, optional start, end, and the price of each tier while it runs
//   DELETE /api/admin/promo   remove the saved promo: pricing goes back to the deploy settings (wrangler.toml + constants.js)
//
// Every save is checked against what the Worker will actually do with it: each promo price must be a whole number of the platform
// currency's minor units and BELOW that tier's standard price (a "promo" above the standard price would raise it), the end must
// lie ahead, and the start must come before the end. Changes are written to the admin audit log (names and numbers only).
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const c = require('../config/constants')
const promoConfig = require('../lib/promoConfig')
const { logAdminAction } = require('../lib/adminAudit')

const MIN_PRICE_CENTS = 100   // below $1 / 1 unit is a mistake, not a promo (and under most processors' minimum)
const LABEL_MAX = 40

// The env as deployed, before the per-request promo overlay (middleware/promoOverlay.js). Falls back to ctx.env when the
// middleware did not run (a test that mounts the handler directly).
const deployEnvOf = ctx => (ctx.get && ctx.get('deployEnv')) || ctx.env
const summarise = r => (r ? { active: r.active, label: r.label, startsAt: r.startsAt, endsAt: r.endsAt, prices: r.prices } : null)

const isoOrNull = v => (v == null || v === '' ? null : v)

const bodySchema = z.object({
  active:   z.boolean(),
  label:    z.string().trim().max(LABEL_MAX).optional(),
  startsAt: z.string().nullable().optional(),
  endsAt:   z.string(),
  prices:   z.object({ FIX: z.number().int(), BADGE: z.number().int(), FIX_PLAIN: z.number().int() }),
})

function describe(env) {
  const supported = c.isSupportedCurrency(env)
  return {
    currency: c.activeCurrency(env),
    priceTableMissing: !supported,
    active: c.isPromoActive(env),
    startsAt: env.PROMO_STARTS_AT || null,
    endsAt: env.PROMO_ENDS_AT || null,
    label: c.promoLabel(env),
    standardCents: supported ? { ...c.priceTable(env).standard } : null,
    promoCents: supported ? { ...c.priceTable(env).promo } : null,
    source: env.__promoSource === 'admin' ? 'admin' : 'deploy',
  }
}

// -> { ok: true, record } | { ok: false, errors: [{ field, message }] }
function validate(input, env, now = Date.now()) {
  const parsed = bodySchema.safeParse(input)
  if (!parsed.success) return { ok: false, errors: parsed.error.errors.map(e => ({ field: e.path.join('.') || 'body', message: e.message })) }
  const body = parsed.data
  const errors = []
  if (!c.isSupportedCurrency(env)) {
    return { ok: false, errors: [{ field: 'prices', message: `There is no price table for ${c.activeCurrency(env)} (constants.js PRICES_BY_CURRENCY), so a promo cannot be priced.` }] }
  }
  const label = (body.label || '').replace(/\s+/g, ' ').trim()
  if (label && /[<>]/.test(label)) errors.push({ field: 'label', message: 'The name cannot contain < or >.' })
  const endsAt = Date.parse(body.endsAt)
  if (Number.isNaN(endsAt)) errors.push({ field: 'endsAt', message: 'The end must be a valid date and time.' })
  else if (body.active && endsAt <= now) errors.push({ field: 'endsAt', message: 'The end is already past, so the promo would never run. Pick a later end or switch the promo off.' })
  const startRaw = isoOrNull(body.startsAt)
  const startsAt = startRaw == null ? null : Date.parse(startRaw)
  if (startRaw != null && Number.isNaN(startsAt)) errors.push({ field: 'startsAt', message: 'The start must be a valid date and time.' })
  else if (startsAt != null && !Number.isNaN(endsAt) && startsAt >= endsAt) errors.push({ field: 'startsAt', message: 'The start must be before the end.' })
  const standard = c.priceTable(env).standard
  for (const tier of promoConfig.TIERS) {
    const price = body.prices[tier]
    if (price < MIN_PRICE_CENTS) errors.push({ field: `prices.${tier}`, message: `${c.tierLabel(tier)} must be at least ${MIN_PRICE_CENTS} (minor units).` })
    else if (tier === 'FIX' && c.welcomeAmountFor(price) < MIN_PRICE_CENTS) errors.push({ field: `prices.${tier}`, message: `Full fix is too low: the ${c.WELCOME_PERCENT_OFF}% welcome code takes it under ${MIN_PRICE_CENTS} (minor units) for a new signup. Raise it to at least ${Math.ceil(MIN_PRICE_CENTS * 100 / (100 - c.WELCOME_PERCENT_OFF))}.` })
    else if (price >= standard[tier]) errors.push({ field: `prices.${tier}`, message: `${c.tierLabel(tier)} must be below its standard price (${standard[tier]}), or the promo would raise it.` })
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, record: {
    active: body.active,
    label,
    startsAt: startsAt == null ? null : new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    prices: { FIX: body.prices.FIX, BADGE: body.prices.BADGE, FIX_PLAIN: body.prices.FIX_PLAIN },
    currency: c.activeCurrency(env),
  } }
}

async function adminGetPromo(ctx) {
  const supabase = getSupabase(ctx.env)
  let stored = null
  try { stored = await promoConfig.readStored(supabase) } catch (err) {
    // system_state exists since migration 0059; an unreadable table is worth saying, not hiding behind "no promo saved".
    console.error('adminGetPromo:', err.message)
    return ctx.json({ success: false, message: 'Could not read the saved promo.' }, 503)
  }
  const base = deployEnvOf(ctx)
  const env = promoConfig.overlayEnv(base, stored)
  return ctx.json({ success: true, data: {
    saved: stored,
    effective: describe(env),
    deploy: { active: base.PROMO_ACTIVE === 'true', endsAt: base.PROMO_ENDS_AT || null },
    limits: { labelMax: LABEL_MAX, minPriceCents: MIN_PRICE_CENTS },
  } })
}

async function adminSetPromo(ctx) {
  let input
  try { input = await ctx.req.json() } catch (_) { return ctx.json({ success: false, message: 'Send the promo as JSON.' }, 400) }
  // Validated against the DEPLOY environment's standard prices and currency, which the overlay never changes.
  const base = deployEnvOf(ctx)
  const result = validate(input, base)
  if (!result.ok) return ctx.json({ success: false, message: result.errors[0].message, errors: result.errors }, 400)
  const supabase = getSupabase(ctx.env)
  const actor = ctx.get('user')
  let previous = null
  try { previous = await promoConfig.readStored(supabase) } catch (_) {}
  const record = { ...result.record, updatedAt: new Date().toISOString(), updatedBy: actor?.id || null }
  await promoConfig.save(supabase, record)
  await logAdminAction(ctx, supabase, 'promo.update', 'promo', 'site', {
    active: record.active, label: record.label, startsAt: record.startsAt, endsAt: record.endsAt, prices: record.prices, currency: record.currency,
    previous: summarise(previous),
  })
  const env = promoConfig.overlayEnv(base, record)
  return ctx.json({ success: true, data: { saved: record, effective: describe(env) } })
}

async function adminClearPromo(ctx) {
  const supabase = getSupabase(ctx.env)
  let previous = null
  try { previous = await promoConfig.readStored(supabase) } catch (_) {}
  await promoConfig.clear(supabase)
  await logAdminAction(ctx, supabase, 'promo.clear', 'promo', 'site', { previous: summarise(previous) })
  // Described from the DEPLOY env: ctx.env is the request's overlaid copy and would still show the promo that was just removed.
  return ctx.json({ success: true, data: { saved: null, effective: describe(deployEnvOf(ctx)) } })
}

module.exports = { adminGetPromo, adminSetPromo, adminClearPromo, validate, describe }
