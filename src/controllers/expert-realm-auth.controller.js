// Experts Phase 2A: sign-in, two-factor, recovery codes, step-up, password reset and session control for the expert realm.
// One cookie (see services/expertSession.service.js). Responses never contain a token: the browser holds it in an HttpOnly cookie.
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const totp = require('../lib/totp')
const fieldCrypto = require('../lib/fieldCrypto')
const { isPwnedPassword } = require('../lib/pwned')
const cfg = require('../lib/expertRealm/config')
const rc = require('../lib/expertRealm/crypto')
const sessions = require('../services/expertSession.service')
const { audit } = require('../services/expertAudit.service')
const mail = require('../services/expertMail.service')

const GENERIC = 'Email or password is not correct.'
const bad = (c, message, status = 400, code) => c.json({ success: false, message, ...(code ? { code } : {}) }, status)
const readJson = async c => { try { return await c.req.json() } catch (_) { return undefined } }
let dummyHash = null
const getDummy = async () => (dummyHash ||= await bcrypt.hash('passthrough-expert-realm-timing-equalizer', 10))
const usable = a => !!a && a.enabled === true && ['probation', 'active'].includes(a.status) && Array.isArray(a.roles) && a.roles.length > 0
const COLS = 'id, email, display_first_name, roles, status, enabled, token_version, totp_enabled_at, totp_secret_enc, totp_last_step, locked_until, failed_logins'
const setCookie = (c, value) => c.header('Set-Cookie', value)

const loginBody = z.object({ email: z.string().trim().toLowerCase().email().max(320), password: z.string().min(1).max(200) }).strict()

async function recordFailure(supabase, account, s) {
  const fails = (account.failed_logins || 0) + 1
  await supabase.from('expert_accounts').update(fails >= s.max_failures
    ? { failed_logins: 0, locked_until: new Date(Date.now() + s.lock_minutes * 60e3).toISOString() } : { failed_logins: fails }).eq('id', account.id)
  return fails >= s.max_failures
}

async function login(c) {
  const p = loginBody.safeParse(await readJson(c)); if (!p.success) return bad(c, GENERIC, 401)
  const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const { data: a, error } = await supabase.from('expert_accounts').select(`${COLS}, password_hash`).eq('email', p.data.email).maybeSingle()
  if (error) throw error
  const match = await bcrypt.compare(p.data.password, (a && a.password_hash) || await getDummy())     // same work whether or not the account exists
  if (a && a.locked_until && new Date(a.locked_until) > new Date()) return bad(c, 'Too many attempts. Please wait and try again.', 429, 'LOCKED')
  if (!a || !match || !usable(a)) {
    if (a && !match) { const locked = await recordFailure(supabase, a, s); await audit(supabase, { actorKind: 'expert', actorId: a.id, action: 'auth.password_failed', targetType: 'account', targetId: a.id, detail: { locked } }) }
    return bad(c, GENERIC, 401)
  }
  const { cookie } = await sessions.createSession(c.env, supabase, a, { ip: c.req.header('cf-connecting-ip'), userAgent: c.req.header('user-agent') })
  setCookie(c, cookie)
  return c.json({ success: true, data: { stage: a.totp_enabled_at ? 'mfa' : 'enroll' } })
}

// First sign-in only: a secret (sealed at rest) shown once; it counts only after a valid code from it is entered.
async function totpSetup(c) {
  const { account } = c.get('xr')
  if (account.totp_enabled_at) return bad(c, 'Two-factor is already set up. Ask an admin to reset it if you lost your device.', 409)
  const supabase = getSupabase(c.env)
  const secret = totp.newSecret(); const sealed = await fieldCrypto.sealTaxId(c.env, secret)
  if (!sealed) { console.error('[CRITICAL] expert realm enrolment: no field encryption key'); return bad(c, 'Not available.', 503) }
  const { error } = await supabase.from('expert_accounts').update({ totp_secret_enc: sealed }).eq('id', account.id).is('totp_enabled_at', null)
  if (error) throw error
  return c.json({ success: true, data: { secret, otpauthUrl: totp.otpauthUrl(secret, account.email) } })
}

// Ten recovery codes, shown once, kept only as keyed hashes. Replaces any earlier set.
async function issueRecoveryCodes(env, supabase, expertId, count) {
  const secret = cfg.secretOf(env); const codes = []
  await supabase.from('expert_recovery_codes').delete().eq('expert_id', expertId)
  for (let i = 0; i < count; i++) codes.push(rc.newRecoveryCode())
  const rows = await Promise.all(codes.map(async code => ({ expert_id: expertId, code_hash: await rc.recoveryHash(secret, expertId, code) })))
  const { error } = await supabase.from('expert_recovery_codes').insert(rows); if (error) throw error
  return codes
}

async function finishSignIn(c, supabase, account, sessionId, extra = {}) {
  const cookie = await sessions.promote(c.env, supabase, account, sessionId)
  if (!cookie) return bad(c, 'Please sign in again.', 401, 'AUTH')
  setCookie(c, cookie)
  await supabase.from('expert_accounts').update({ failed_logins: 0, last_login_at: new Date().toISOString() }).eq('id', account.id)
  await audit(supabase, { actorId: account.id, roles: account.roles, action: 'auth.signed_in', targetType: 'session', targetId: sessionId, detail: extra.method ? { method: extra.method } : {} })
  return null
}

const codeBody = z.object({ code: z.string().trim().min(6).max(24) }).strict()

async function totpVerify(c) {
  const { account: a0, session } = c.get('xr'); const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const p = codeBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Enter the 6-digit code.', 400)
  const { data: a } = await supabase.from('expert_accounts').select(COLS).eq('id', a0.id).maybeSingle()
  if (a.locked_until && new Date(a.locked_until) > new Date()) return bad(c, 'Too many attempts. Please wait and try again.', 429, 'LOCKED')
  const secret = a.totp_secret_enc ? await fieldCrypto.openTaxId(c.env, a.totp_secret_enc) : null
  const step = secret ? await totp.verifyTotp(secret, p.data.code, { lastStep: a.totp_last_step }) : null
  if (step === null || step === undefined || step === false) {
    const locked = await recordFailure(supabase, a, s)
    await audit(supabase, { actorId: a.id, roles: a.roles, action: 'auth.second_factor_failed', targetType: 'session', targetId: session.id, detail: { locked } })
    return bad(c, 'That code did not work.', 401, 'BAD_CODE')
  }
  const enrolling = !a.totp_enabled_at
  await supabase.from('expert_accounts').update({ totp_last_step: step, ...(enrolling ? { totp_enabled_at: new Date().toISOString() } : {}) }).eq('id', a.id)
  const refused = await finishSignIn(c, supabase, a, session.id, { method: 'totp' }); if (refused) return refused
  // recovery codes are issued at enrolment, and also to a pilot account that enrolled in Phase 1 and has none yet
  const { data: have } = await supabase.from('expert_recovery_codes').select('id').eq('expert_id', a.id).limit(1)
  const recoveryCodes = !(have && have.length) ? await issueRecoveryCodes(c.env, supabase, a.id, s.recovery_codes) : null
  if (recoveryCodes) await audit(supabase, { actorId: a.id, roles: a.roles, action: 'auth.recovery_codes_issued', targetType: 'account', targetId: a.id, detail: { count: recoveryCodes.length } })
  return c.json({ success: true, data: { stage: 'full', ...(recoveryCodes ? { recoveryCodes } : {}) } })
}

async function recover(c) {
  const { account: a0, session } = c.get('xr'); const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const p = codeBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Enter a recovery code.', 400)
  const { data: a } = await supabase.from('expert_accounts').select(COLS).eq('id', a0.id).maybeSingle()
  if (!a.totp_enabled_at) return bad(c, 'Not available.', 409)
  if (a.locked_until && new Date(a.locked_until) > new Date()) return bad(c, 'Too many attempts. Please wait and try again.', 429, 'LOCKED')
  const hash = await rc.recoveryHash(cfg.secretOf(c.env), a.id, p.data.code)
  const { data: used } = await supabase.from('expert_recovery_codes').update({ used_at: new Date().toISOString() }).eq('expert_id', a.id).eq('code_hash', hash).is('used_at', null).select('id').maybeSingle()
  if (!used) {
    const locked = await recordFailure(supabase, a, s)
    await audit(supabase, { actorId: a.id, roles: a.roles, action: 'auth.recovery_failed', targetType: 'session', targetId: session.id, detail: { locked } })
    return bad(c, 'That code did not work.', 401, 'BAD_CODE')
  }
  const refused = await finishSignIn(c, supabase, a, session.id, { method: 'recovery_code' }); if (refused) return refused
  const { data: left } = await supabase.from('expert_recovery_codes').select('id').eq('expert_id', a.id).is('used_at', null).limit(100)
  return c.json({ success: true, data: { stage: 'full', recoveryCodesLeft: (left || []).length } })
}

async function me(c) {
  const { account, session, roles } = c.get('xr')
  return c.json({ success: true, data: { id: account.id, firstName: account.display_first_name || null, roles, totpEnabled: !!account.totp_enabled_at,
    sessionExpiresAt: session.absolute_expires_at, elevatedUntil: session.elevated_until || null } })
}

async function logout(c) {
  const { account, session } = c.get('xr'); const supabase = getSupabase(c.env)
  await sessions.revoke(supabase, session.id, account.id, 'signed_out')
  setCookie(c, sessions.clearCookieHeader())
  return c.json({ success: true })
}

async function logoutAll(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env)
  await sessions.revokeAll(supabase, account, 'revoke_all')
  await audit(supabase, { actorId: account.id, roles, action: 'auth.revoke_all', targetType: 'account', targetId: account.id })
  setCookie(c, sessions.clearCookieHeader())
  return c.json({ success: true })
}

async function listSessions(c) {
  const { account, session } = c.get('xr'); const rows = await sessions.listSessions(getSupabase(c.env), account.id)
  return c.json({ success: true, data: { sessions: rows.map(r => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.absolute_expires_at, device: r.user_agent || null, current: r.id === session.id })) } })
}

async function endSession(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env)
  const ended = await sessions.revoke(supabase, c.req.param('id'), account.id, 'ended_by_owner')
  if (ended) await audit(supabase, { actorId: account.id, roles, action: 'auth.session_ended', targetType: 'session', targetId: c.req.param('id') })
  return c.json({ success: true })
}

// Step-up: a fresh password check lifts the session for a few minutes (refunds, unmasking, settings need it).
async function stepUp(c) {
  const { account, session } = c.get('xr'); const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const p = z.object({ password: z.string().min(1).max(200) }).strict().safeParse(await readJson(c)); if (!p.success) return bad(c, 'Enter your password.', 400)
  const { data: a } = await supabase.from('expert_accounts').select('password_hash, failed_logins, id').eq('id', account.id).maybeSingle()
  if (!(await bcrypt.compare(p.data.password, a.password_hash))) { const locked = await recordFailure(supabase, a, s); return bad(c, 'That password is not correct.', locked ? 429 : 401, 'BAD_PASSWORD') }
  const until = await sessions.elevate(supabase, session.id)
  return c.json({ success: true, data: { elevatedUntil: until } })
}

async function passwordProblem(c, password, email) {
  const s = await cfg.loadSettings(getSupabase(c.env))
  if (typeof password !== 'string' || password.length < s.min_password_length) return `Use at least ${s.min_password_length} characters.`
  if (password.length > 200) return 'That password is too long.'
  if (email && password.toLowerCase() === String(email).toLowerCase()) return 'Your password cannot be your email.'
  try { if (await isPwnedPassword(password, c.env)) return 'That password has appeared in a data breach. Choose another.' } catch (_) { /* fail open, like the main app */ }
  return null
}

async function forgot(c) {
  const p = z.object({ email: z.string().trim().toLowerCase().email().max(320) }).strict().safeParse(await readJson(c))
  const done = () => c.json({ success: true, data: { message: 'If that account exists, an email is on its way.' } })      // same answer either way
  if (!p.success) return done()
  const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const { data: a } = await supabase.from('expert_accounts').select('id, email, enabled, status, roles').eq('email', p.data.email).maybeSingle()
  if (!usable(a)) return done()
  const secret = cfg.secretOf(c.env); const token = rc.randomToken(32)
  await supabase.from('expert_password_resets').update({ used_at: new Date().toISOString() }).eq('expert_id', a.id).is('used_at', null)
  await supabase.from('expert_password_resets').insert({ expert_id: a.id, token_hash: await rc.tokenHash(secret, token), expires_at: new Date(Date.now() + s.reset_minutes * 60e3).toISOString(), requested_ip_hash: await rc.ipHash(secret, c.req.header('cf-connecting-ip')) })
  await mail.sendPasswordReset(c.env, { to: a.email, link: `${cfg.siteOrigin(c.env)}/reset-password#token=${token}` })
  await audit(supabase, { actorKind: 'expert', actorId: a.id, action: 'auth.reset_requested', targetType: 'account', targetId: a.id })
  return done()
}

async function reset(c) {
  const p = z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(200) }).strict().safeParse(await readJson(c)); if (!p.success) return bad(c, 'This link is not valid.', 400)
  const supabase = getSupabase(c.env)
  const hash = await rc.tokenHash(cfg.secretOf(c.env), p.data.token)
  const { data: row } = await supabase.from('expert_password_resets').select('id, expert_id, expires_at, used_at').eq('token_hash', hash).maybeSingle()
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) return bad(c, 'This link is not valid or has expired.', 400)
  const { data: a } = await supabase.from('expert_accounts').select('id, email, token_version, roles').eq('id', row.expert_id).maybeSingle()
  const problem = await passwordProblem(c, p.data.password, a && a.email); if (problem) return bad(c, problem, 400, 'WEAK_PASSWORD')
  const { data: claimed } = await supabase.from('expert_password_resets').update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id').maybeSingle()
  if (!claimed) return bad(c, 'This link is not valid or has expired.', 400)       // another request used it first
  await supabase.from('expert_accounts').update({ password_hash: await bcrypt.hash(p.data.password, 10), failed_logins: 0, locked_until: null }).eq('id', a.id)
  await sessions.revokeAll(supabase, a, 'password_reset')                          // every session ends; the second factor is still required to sign in
  await audit(supabase, { actorKind: 'expert', actorId: a.id, action: 'auth.password_reset', targetType: 'account', targetId: a.id })
  return c.json({ success: true })
}

async function changePassword(c) {
  const { account, roles, session } = c.get('xr'); const supabase = getSupabase(c.env)
  const p = z.object({ current: z.string().min(1).max(200), next: z.string().min(1).max(200) }).strict().safeParse(await readJson(c)); if (!p.success) return bad(c, 'Fill in both fields.', 400)
  const { data: a } = await supabase.from('expert_accounts').select('id, email, password_hash, token_version, failed_logins').eq('id', account.id).maybeSingle()
  if (!(await bcrypt.compare(p.data.current, a.password_hash))) { await recordFailure(supabase, a, await cfg.loadSettings(supabase)); return bad(c, 'Your current password is not correct.', 401, 'BAD_PASSWORD') }
  const problem = await passwordProblem(c, p.data.next, a.email); if (problem) return bad(c, problem, 400, 'WEAK_PASSWORD')
  await supabase.from('expert_accounts').update({ password_hash: await bcrypt.hash(p.data.next, 10) }).eq('id', a.id)
  await sessions.revokeAll(supabase, a, 'password_changed')
  await audit(supabase, { actorId: a.id, roles, action: 'auth.password_changed', targetType: 'account', targetId: a.id })
  setCookie(c, sessions.clearCookieHeader())
  return c.json({ success: true, data: { signedOut: true } })
}

async function newRecoveryCodes(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env); const s = await cfg.loadSettings(supabase)
  const codes = await issueRecoveryCodes(c.env, supabase, account.id, s.recovery_codes)
  await audit(supabase, { actorId: account.id, roles, action: 'auth.recovery_codes_issued', targetType: 'account', targetId: account.id, detail: { count: codes.length } })
  return c.json({ success: true, data: { recoveryCodes: codes } })
}

module.exports = { login, totpSetup, totpVerify, recover, me, logout, logoutAll, listSessions, endSession, stepUp, forgot, reset, changePassword, newRecoveryCodes }
