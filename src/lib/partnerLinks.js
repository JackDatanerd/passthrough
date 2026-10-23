// Partner dashboard links (round 27).
//
// The dashboard token used to be stored in partners.dashboard_token so emails could re-send it, which meant a database
// or backup read produced every partner's working dashboard link. It is now DERIVED:
//
//     <partner id>.<HMAC-SHA512(secret, "partner-dashboard:<partner id>:<version>")>
//
// Nothing secret is stored. Bumping partners.dashboard_token_version kills the old link and yields a new one; the
// secret never leaves the Worker. Partners created before migration 0107 still have a stored dashboard_token, which
// keeps working (and keeps being the link emails carry) until their link is next rotated, at which point the stored
// value is cleared and the derived form takes over.
const cryptoLib = require('./crypto')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let warnedFallback = false
function linkSecret(env) {
  const secret = env.PARTNER_LINK_SECRET || env.JWT_SECRET
  // Round 29: with only JWT_SECRET set, rotating it silently kills every emailed dashboard link. Say so once per isolate.
  if (!env.PARTNER_LINK_SECRET && secret && !warnedFallback) {
    warnedFallback = true
    console.warn('PARTNER_LINK_SECRET is not set: partner dashboard links are derived from JWT_SECRET, so rotating JWT_SECRET will invalidate every emailed dashboard link. Set a dedicated PARTNER_LINK_SECRET.')
  }
  if (!secret) throw new Error('PARTNER_LINK_SECRET / JWT_SECRET is not set — cannot derive partner dashboard links')
  return secret
}

async function mac(env, partnerId, version) {
  return cryptoLib.hmacSha512Hex(linkSecret(env), `partner-dashboard:${partnerId}:${Number(version) || 0}`)
}

async function deriveDashboardToken(env, partnerId, version = 0) {
  return `${partnerId}.${await mac(env, partnerId, version)}`
}

// The token a partner row's emails should carry right now: the legacy stored one if it still exists, else the derived one.
async function dashboardTokenOf(env, partner) {
  if (partner.dashboard_token) return partner.dashboard_token
  return deriveDashboardToken(env, partner.id, partner.dashboard_token_version)
}

async function dashboardUrlOf(env, partner) {
  return `${env.FRONTEND_URL}/partner/dashboard?token=${await dashboardTokenOf(env, partner)}`
}

// Columns every caller that builds a dashboard link must select.
const DASHBOARD_LINK_COLUMNS = 'id, dashboard_token, dashboard_token_version'

// The patch that revokes the current dashboard link; the new link is dashboardUrlOf(env, { ...partner, ...patch }).
function rotateDashboardPatch(partner) {
  return { dashboard_token: null, dashboard_token_version: (Number(partner.dashboard_token_version) || 0) + 1 }
}

// Resolve a presented dashboard token to a partner row (or null). `select` is the column list WITHOUT the link columns.
async function findPartnerByDashboardToken(env, supabase, token, select = 'id', decorate = q => q) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 400) return null
  const legacy = async () => {
    const { data, error } = await decorate(supabase.from('partners').select(`${select}, dashboard_token_version`)
      .eq('dashboard_token', token)).maybeSingle()
    if (error) throw error
    return data || null
  }
  const dot = token.indexOf('.')
  if (dot === -1) return legacy()
  const id = token.slice(0, dot), presented = token.slice(dot + 1)
  // A dotted string that is not a well-formed derived link is not necessarily junk: it gets the stored-token lookup.
  if (!UUID_RE.test(id) || !/^[0-9a-f]{128}$/.test(presented)) return legacy()
  const { data, error } = await decorate(supabase.from('partners').select(`${select}, dashboard_token_version`).eq('id', id)).maybeSingle()
  if (error) throw error
  if (!data) return null
  const expected = await mac(env, id, data.dashboard_token_version)
  return cryptoLib.timingSafeEqual(presented, expected) ? data : null
}

module.exports = { deriveDashboardToken, dashboardTokenOf, dashboardUrlOf, rotateDashboardPatch, findPartnerByDashboardToken, DASHBOARD_LINK_COLUMNS }
