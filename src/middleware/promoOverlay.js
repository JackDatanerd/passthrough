// Hands every /api request the promo an admin set from the panel (see lib/promoConfig.js). Runs after envCheck. Any failure falls
// through to the deploy settings: a promo lookup must never be the reason a price, a checkout or a page fails.
const promoConfig = require('../lib/promoConfig')
const { getSupabase } = require('../config/supabase')

async function promoOverlay(c, next) {
  try {
    const record = await promoConfig.current(getSupabase(c.env))
    // The untouched deploy env rides along: the admin Promotions screen must describe what "revert" returns to, which the overlaid copy cannot.
    c.set('deployEnv', c.env)
    if (record) c.env = promoConfig.overlayEnv(c.env, record)
  } catch (err) {
    console.error('promo overlay skipped:', err.message)
  }
  return next()
}

module.exports = promoOverlay
