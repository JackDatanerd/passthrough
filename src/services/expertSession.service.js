// Experts Phase 2A: server-side sessions for the expert realm. The cookie carries a signed token {sub, sid, tv, aud}; the session row and the
// account's token_version decide whether it still counts. Limits (8 hours idle, 7 days absolute) come from settings, never constants.
const jwt = require('../lib/jwt')
const { COOKIE_NAME, secretOf, loadSettings } = require('../lib/expertRealm/config')
const { ipHash } = require('../lib/expertRealm/crypto')

const AUD = 'expert-realm'
const TOUCH_EVERY_MS = 60e3          // last_seen_at is written at most once a minute per session, not on every request

// The ONE cookie: HttpOnly, Secure, SameSite=Strict, Path=/, no Domain (the __Host- prefix demands all four), so the browser sends it only
// to the expert site's own host. maxAge 0 clears it.
function cookieHeader(value, maxAgeSeconds) {
  return `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
}
const clearCookieHeader = () => cookieHeader('', 0)
function readCookie(header, name = COOKIE_NAME) {
  if (!header) return null
  for (const part of String(header).split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() }
  return null
}

// AUDIT A1 pass 2 (item 8): sessions that never finished sign-in (pending, expired) and anything expired more than 30 days ago are deleted for this
// expert each time they sign in. Best effort: a failure here never blocks a sign-in.
async function pruneSessions(supabase, expertId, now = Date.now()) {
  try {
    await supabase.from('expert_sessions').delete().eq('expert_id', expertId).is('mfa_verified_at', null).lt('absolute_expires_at', new Date(now).toISOString())
    await supabase.from('expert_sessions').delete().eq('expert_id', expertId).lt('absolute_expires_at', new Date(now - 30 * 86400e3).toISOString())
  } catch (_) { /* best effort */ }
}

// Password checked: a PENDING session (no second factor yet) that expires in minutes, not days.
async function createSession(env, supabase, account, { ip, userAgent, now = Date.now() } = {}) {
  const secret = secretOf(env); if (!secret) throw new Error('expert realm secret missing')
  await pruneSessions(supabase, account.id, now)
  const s = await loadSettings(supabase, now)
  const pendingUntil = new Date(now + s.pending_minutes * 60e3).toISOString()
  const { data, error } = await supabase.from('expert_sessions').insert({
    expert_id: account.id, absolute_expires_at: pendingUntil, last_seen_at: new Date(now).toISOString(),
    ip_hash: ip ? await ipHash(secret, ip) : null, user_agent: userAgent ? String(userAgent).slice(0, 200) : null }).select('id').single()
  if (error || !data) throw new Error('session create failed')
  return { sessionId: data.id, cookie: await mint(env, supabase, account, data.id, now) }
}

// The token is minted for the full absolute lifetime; the row's absolute_expires_at (short while pending) is what really ends the session.
async function mint(env, supabase, account, sessionId, now = Date.now()) {
  const s = await loadSettings(supabase, now)
  const secs = Math.floor(s.absolute_days * 86400)
  const token = await jwt.sign({ sub: account.id, sid: sessionId, tv: account.token_version, aud: AUD }, secretOf(env), secs)
  return cookieHeader(token, secs)
}

// Second factor passed: end the PENDING session and open a NEW session row at its full lifetime, with a new cookie.
// AUDIT (auth/sessions 1, F2): this used to keep the same session id and re-sign identical claims, so the cookie held from the password step
// (which was never promised to stay inert) became the full session, and "rotate the cookie" was not true. Now the pending id dies here.
// Returns the new cookie string; the new session id is on the second value of promoteSession() for callers that need it.
async function promoteSession(env, supabase, account, pendingId, now = Date.now()) {
  const s = await loadSettings(supabase, now)
  const { data: old } = await supabase.from('expert_sessions').select('ip_hash, user_agent, absolute_expires_at, revoked_at').eq('id', pendingId).eq('expert_id', account.id).maybeSingle()
  if (!old || old.revoked_at || now >= new Date(old.absolute_expires_at).getTime()) return null
  const abs = new Date(now + s.absolute_days * 86400e3).toISOString(), at = new Date(now).toISOString()
  const { data: fresh } = await supabase.from('expert_sessions').insert({ expert_id: account.id, mfa_verified_at: at, absolute_expires_at: abs, last_seen_at: at, ip_hash: old.ip_hash, user_agent: old.user_agent }).select('id').single()
  if (!fresh) return null
  const { data: ended } = await supabase.from('expert_sessions').update({ revoked_at: at, revoked_reason: 'promoted' }).eq('id', pendingId).eq('expert_id', account.id).is('revoked_at', null).select('id').maybeSingle()
  if (!ended) { await supabase.from('expert_sessions').update({ revoked_at: at, revoked_reason: 'promote_race' }).eq('id', fresh.id); return null }     // another request promoted it first
  return { cookie: await mint(env, supabase, account, fresh.id, now), sessionId: fresh.id }
}
const promote = async (...a) => { const r = await promoteSession(...a); return r && r.cookie }

// Resolve a request's cookie to { account, session } or { error }. Never throws for a bad token. Checks, in order: signature, audience,
// session row (exists, not revoked, not past absolute, within idle), account (enabled, usable status, a role, token_version).
async function resolve(env, supabase, cookieValue, now = Date.now()) {
  const secret = secretOf(env)
  if (!secret || !cookieValue) return { error: 'NO_SESSION' }
  let claims
  try { claims = await jwt.verify(cookieValue, secret) } catch (_) { return { error: 'BAD_TOKEN' } }
  if (claims.aud !== AUD || !claims.sid || !claims.sub) return { error: 'BAD_TOKEN' }
  const { data: session } = await supabase.from('expert_sessions').select('*').eq('id', claims.sid).eq('expert_id', claims.sub).maybeSingle()
  if (!session || session.revoked_at) return { error: 'SESSION_ENDED' }
  const s = await loadSettings(supabase, now)
  if (now >= new Date(session.absolute_expires_at).getTime()) return { error: 'SESSION_EXPIRED' }
  if (now - new Date(session.last_seen_at).getTime() > s.idle_hours * 3600e3) return { error: 'SESSION_IDLE' }
  const { data: account } = await supabase.from('expert_accounts').select('id, email, display_first_name, display_initial, roles, status, enabled, token_version, totp_enabled_at').eq('id', claims.sub).maybeSingle()
  if (!account || !account.enabled || !['probation', 'active'].includes(account.status) || !(account.roles || []).length) return { error: 'ACCOUNT_UNUSABLE' }
  if (account.token_version !== claims.tv) return { error: 'SESSION_ENDED' }
  if (now - new Date(session.last_seen_at).getTime() > TOUCH_EVERY_MS)
    await supabase.from('expert_sessions').update({ last_seen_at: new Date(now).toISOString() }).eq('id', session.id)
  return { account, session, stage: session.mfa_verified_at ? 'full' : 'pending' }
}

const isElevated = (session, now = Date.now()) => !!session.elevated_until && new Date(session.elevated_until).getTime() > now
async function elevate(supabase, sessionId, now = Date.now()) {
  const s = await loadSettings(supabase, now)
  const until = new Date(now + s.step_up_minutes * 60e3).toISOString()
  await supabase.from('expert_sessions').update({ elevated_until: until }).eq('id', sessionId)
  return until
}

async function revoke(supabase, sessionId, expertId, reason) {
  const { data } = await supabase.from('expert_sessions').update({ revoked_at: new Date().toISOString(), revoked_reason: String(reason || 'signed_out').slice(0, 60) })
    .eq('id', sessionId).eq('expert_id', expertId).is('revoked_at', null).select('id').maybeSingle()
  return !!data
}

// "Revoke all sessions": every row ends AND token_version moves, so even a cookie whose row somehow survived stops verifying.
async function revokeAll(supabase, account, reason = 'revoke_all') {
  await supabase.from('expert_sessions').update({ revoked_at: new Date().toISOString(), revoked_reason: reason }).eq('expert_id', account.id).is('revoked_at', null)
  // item 9: compare-and-set on the value read, so two simultaneous calls each move it (it used to be read, +1, write)
  let cur = account.token_version || 0
  for (let i = 0; i < 6; i++) {
    const { data } = await supabase.from('expert_accounts').update({ token_version: cur + 1 }).eq('id', account.id).eq('token_version', cur).select('id').maybeSingle()
    if (data) return
    const { data: fresh } = await supabase.from('expert_accounts').select('token_version').eq('id', account.id).maybeSingle()
    if (!fresh) return
    cur = fresh.token_version || 0
  }
}

async function listSessions(supabase, expertId, now = Date.now()) {
  const { data } = await supabase.from('expert_sessions').select('id, created_at, last_seen_at, absolute_expires_at, mfa_verified_at, user_agent').eq('expert_id', expertId).is('revoked_at', null).order('created_at', { ascending: false }).limit(50)
  return (data || []).filter(r => new Date(r.absolute_expires_at).getTime() > now && r.mfa_verified_at)
}

module.exports = { pruneSessions, AUD, cookieHeader, clearCookieHeader, readCookie, createSession, mint, promote, promoteSession, resolve, isElevated, elevate, revoke, revokeAll, listSessions }
