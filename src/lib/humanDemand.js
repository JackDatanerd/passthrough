// Passthrough Experts, Phase 0A: the Human rewrite demand test (fake door). Pure helpers for the routes in
// routes/human-demand.routes.js. See docs/experts/STATUS.md for the decisions behind the numbers.
//
// Nothing here takes a payment, creates a job, or touches a discount, promo, welcome, referral or partner path.

const { sha256 } = require('./crypto')

// The one switch. Off unless the environment variable is exactly the string "true" (the convention PROMO_ACTIVE uses).
// Set it as a Worker var / secret: HUMAN_DEMAND_ENABLED=true. Unset, anything else, or a typo means OFF.
function humanDemandEnabled(env) {
  return !!env && env.HUMAN_DEMAND_ENABLED === 'true'
}

// Tier names are the engineering spec's (pack index, terminology map).
const TIERS = ['polish', 'seven_day', 'forty_eight_hour', 'twenty_four_hour']
const VARIANTS = ['low', 'base', 'high']
const EVENTS = ['button_shown', 'button_clicked', 'tier_selected', 'cover_letter_toggled', 'waitlist_submitted', 'modal_dismissed']

// Product spec 16.1, in US dollar cents. "base" is the suggested start; "low" and "high" are the ends of the test range in the
// same table. These are PROPOSALS for a demand test and the expected launch price shown to the visitor, not charges.
//                       polish  7-day  48-hour  24-hour  cover letter
const PRICE_VARIANTS = {
  low:  { polish: 4900, seven_day: 7900, forty_eight_hour: 9900,  twenty_four_hour: 12900, cover_letter: 2500 },
  base: { polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 },
  high: { polish: 6900, seven_day: 9900, forty_eight_hour: 13900, twenty_four_hour: 17900, cover_letter: 3900 },
}
const CURRENCY = 'USD'

// A visitor id is 32 lower-case hex characters, made by the browser and kept in its local storage.
const VISITOR_ID_RE = /^[a-f0-9]{32}$/
function isVisitorId(v) { return typeof v === 'string' && VISITOR_ID_RE.test(v) }

// The variant is a pure function of the visitor id, so the same browser sees the same prices on every visit with nothing stored.
// The salt names the experiment: change it to re-draw everyone for a new test (and say so in STATUS.md).
const SALT = 'human-demand-v1:'
async function variantForVisitor(visitorId) {
  const hex = await sha256(SALT + visitorId)
  return VARIANTS[parseInt(hex.slice(0, 8), 16) % VARIANTS.length]
}

function priceTable(variant) {
  const t = PRICE_VARIANTS[variant]
  return t ? { ...t } : null
}

// Email check for a visitor without an account: deliberately plain (one @, a dot in the domain, no spaces, a sane length). The
// database holds the same shape as a last line of defence.
function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  if (e.length < 5 || e.length > 254) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
  return e
}

module.exports = {
  humanDemandEnabled, TIERS, VARIANTS, EVENTS, PRICE_VARIANTS, CURRENCY,
  isVisitorId, variantForVisitor, priceTable, normaliseEmail,
}
