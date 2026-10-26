// Passthrough Experts, Phase 0A: the Human rewrite demand test (fake door). Three public, rate-limited endpoints, all behind the
// HUMAN_DEMAND_ENABLED flag (routes/human-demand.routes.js answers 404 for every one of them while it is off).
//
//   GET  /api/human-demand/config?vid=<visitor id>  -> the price variant for this visitor and its price table
//   POST /api/human-demand/events                   -> one funnel step (no free text is accepted, ever)
//   POST /api/human-demand/waitlist                 -> join the waitlist for one tier (idempotent, no payment)
//
// What this deliberately does NOT do: take a payment, create a job, resolve a code, reserve a usage slot, stamp a referral or
// commission, or send an email. Nothing here imports the payment, referral, partner or promo code.
//
// The price variant is ALWAYS derived on the server from the visitor id. A client-supplied variant, price or tier price is never
// read, so the data cannot be skewed by a bug or a hand-built request.

const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const { must, warnOnError } = require('../lib/db')
const hd = require('../lib/humanDemand')

const visitorId = z.string().refine(hd.isVisitorId, 'Invalid visitor id.')
const tier = z.enum(hd.TIERS)

// .strict(): an unknown key is a 400, so nothing outside this list (a pasted resume, a name) can ride along into storage.
const eventBody = z.object({
  event: z.enum(hd.EVENTS),
  visitorId,
  tier: tier.optional(),
  coverLetter: z.boolean().optional(),
}).strict()

const waitlistBody = z.object({
  visitorId,
  tier,
  coverLetter: z.boolean().optional().default(false),
  consent: z.boolean().optional().default(false),
  email: z.string().max(320).optional(),
}).strict()

async function readJson(c) {
  try { return await c.req.json() } catch (_) { return undefined }
}
const bad = (c, message, status = 400) => c.json({ success: false, message }, status)

async function getConfig(c) {
  const vid = (c.req.query ? c.req.query('vid') : '') || ''
  if (!hd.isVisitorId(vid)) return bad(c, 'Invalid visitor id.')
  const variant = await hd.variantForVisitor(vid)
  return c.json({ success: true, data: { variant, currency: hd.CURRENCY, prices: hd.priceTable(variant), tiers: hd.TIERS } })
}

async function postEvent(c) {
  const parsed = eventBody.safeParse(await readJson(c))
  if (!parsed.success) return bad(c, 'Invalid event.')
  const { event, visitorId: vid, tier: t, coverLetter } = parsed.data
  // The two events that are about a choice must say what was chosen.
  if (event === 'tier_selected' && !t) return bad(c, 'Invalid event.')
  if (event === 'cover_letter_toggled' && typeof coverLetter !== 'boolean') return bad(c, 'Invalid event.')
  // The server records waitlist_submitted itself, when a row is really created. A client cannot claim one.
  if (event === 'waitlist_submitted') return bad(c, 'Invalid event.')

  const row = {
    event,
    visitor_id: vid,
    price_variant: await hd.variantForVisitor(vid),
    tier: t ?? null,
    cover_letter: typeof coverLetter === 'boolean' ? coverLetter : null,
  }
  must(await getSupabase(c.env).from('human_demand_events').insert(row), 'record human demand event')
  return c.json({ success: true })
}

async function postWaitlist(c) {
  const parsed = waitlistBody.safeParse(await readJson(c))
  if (!parsed.success) return bad(c, 'Please check what you entered and try again.')
  const { visitorId: vid, tier: t, coverLetter, consent, email: rawEmail } = parsed.data

  // A token that exists but cannot be checked right now is "try again", never "treat as a stranger" (same rule as createScan).
  if (c.get('authError') === 'unavailable') return bad(c, 'Please try again in a moment.', 503)
  const user = c.get('user')

  let identity
  if (user && user.id) {
    // Signed in: the account is the identity, and the account's email is NOT copied here (erasing the account erases it).
    identity = { identity_key: `u:${user.id}`, user_id: user.id, email: null }
  } else {
    const email = hd.normaliseEmail(rawEmail)
    if (!email) return bad(c, 'Please enter a valid email address.')
    // An address is only taken from a visitor with no account because they ask to hear when this opens.
    if (!consent) return bad(c, 'Please tick the box to say we may email you when this opens.')
    identity = { identity_key: `e:${email}`, user_id: null, email }
  }

  const variant = await hd.variantForVisitor(vid)
  const prices = hd.priceTable(variant)
  const supabase = getSupabase(c.env)

  // Idempotent: the first write for (person, tier) creates the row, every later one leaves its price variant and quote as they
  // were (they are what that person was SHOWN) and only refreshes the two things a person can change their mind about.
  const inserted = must(await supabase.from('human_demand_waitlist').upsert({
    ...identity,
    tier: t,
    cover_letter_interest: coverLetter,
    price_variant: variant,
    quoted_cents: prices[t],
    cover_letter_quoted_cents: prices.cover_letter,
    contact_consent: consent,
    visitor_id: vid,
  }, { onConflict: 'identity_key,tier', ignoreDuplicates: true }).select('id'), 'join human demand waitlist')
  const created = Array.isArray(inserted.data) && inserted.data.length > 0

  if (!created) {
    must(await supabase.from('human_demand_waitlist')
      .update({ cover_letter_interest: coverLetter, contact_consent: consent, updated_at: new Date().toISOString() })
      .eq('identity_key', identity.identity_key).eq('tier', t), 'refresh human demand waitlist row')
  } else {
    // Counted once per new row, by the server, so the funnel's last step can only be reached by really joining. Best effort: a
    // lost event must never undo a join.
    warnOnError(await supabase.from('human_demand_events').insert({
      event: 'waitlist_submitted', visitor_id: vid, price_variant: variant, tier: t, cover_letter: coverLetter,
    }), 'record waitlist_submitted event')
  }
  return c.json({ success: true, data: { joined: true, alreadyOnList: !created } })
}

module.exports = { getConfig, postEvent, postWaitlist }
