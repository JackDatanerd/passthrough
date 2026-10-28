// Experts Phase 1: the EXPERT realm's authentication. Its own signing secret (env.EXPERT_JWT_SECRET, which must differ from JWT_SECRET),
// its own audience, its own claim names, its own account table. Nothing here reads the main app's users, tokens or sessions, and
// the main app's auth middleware (which verifies with JWT_SECRET) cannot verify an expert token: a token from one realm is
// rejected by the other on its signature alone, before any claim is looked at.
const jwt = require('../lib/jwt')
const { getSupabase } = require('../config/supabase')

const AUD = 'passthrough-experts'
const FULL_TTL_SECONDS = 8 * 3600
const PENDING_TTL_SECONDS = 10 * 60

function secretOf(env) {
  const s = env && env.EXPERT_JWT_SECRET
  if (typeof s !== 'string' || s.length < 32) return null
  if (env.JWT_SECRET && s === env.JWT_SECRET) return null      // one secret for both realms would make tokens interchangeable
  return s
}
const mint = (env, expert, stage) => {
  const secret = secretOf(env)
  if (!secret) throw new Error('EXPERT_JWT_SECRET is missing, short, or equal to JWT_SECRET')   // never sign with a bad secret
  return jwt.sign({ sub: expert.id, aud: AUD, typ: 'expert', stage, tv: expert.token_version }, secret, stage === 'full' ? FULL_TTL_SECONDS : PENDING_TTL_SECONDS)
}

const COLS = 'id, email, display_first_name, display_initial, roles, status, enabled, token_version, totp_enabled_at, totp_secret_enc, totp_last_step, agreement_signed_at, locked_until'
const usable = e => !!e && e.enabled === true && ['probation', 'active'].includes(e.status) && Array.isArray(e.roles) && e.roles.includes('expert')

// requireStage: 'full' (a signed-in, second-factor-verified session) or 'pending' (password checked, second factor still to do)
function expertAuth(requireStage = 'full') {
  return async (c, next) => {
    const deny = (message = 'Authentication required.') => c.json({ success: false, message }, 401)
    const secret = secretOf(c.env)
    if (!secret) { console.error('[CRITICAL] EXPERT_JWT_SECRET is missing, short, or equal to JWT_SECRET: expert sign-in is refused'); return c.json({ success: false, message: 'Not available.' }, 503) }
    const header = c.req.header('Authorization') || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token) return deny()
    let claims
    try { claims = await jwt.verify(token, secret) } catch (_) { return deny() }
    if (!claims || claims.aud !== AUD || claims.typ !== 'expert' || claims.stage !== requireStage || typeof claims.sub !== 'string') return deny()
    const { data: expert, error } = await getSupabase(c.env).from('expert_accounts').select(COLS).eq('id', claims.sub).maybeSingle()
    if (error) throw error
    if (!usable(expert) || expert.token_version !== claims.tv) return deny()
    c.set('expert', expert)
    return next()
  }
}

module.exports = { expertAuth, mint, secretOf, usable, AUD, COLS, FULL_TTL_SECONDS, PENDING_TTL_SECONDS }
