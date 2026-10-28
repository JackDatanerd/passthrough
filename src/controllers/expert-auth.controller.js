// Experts Phase 1: sign-in for the hand-created pilot experts. Password, then a time-based code from an authenticator app. There is no
// self-registration, no password reset by email and no recovery codes in the pilot: the operator creates the account, hands over a
// one-time password, and resets the second factor by hand (Admin > Human orders > Experts). Every failure answers the same words.
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const fieldCrypto = require('../lib/fieldCrypto')
const totp = require('../lib/totp')
const { mint, usable, secretOf, COLS } = require('../middleware/expertAuth')

const MAX_FAILS = 5
const LOCK_MINUTES = 15
const GENERIC = 'Those details are not right.'
const bad = (c, message, status = 400) => c.json({ success: false, message }, status)
const readJson = async c => { try { return await c.req.json() } catch (_) { return undefined } }
let dummyHash = null
const getDummy = async () => (dummyHash ||= await bcrypt.hash('passthrough-experts-timing-equalizer', 10))

const loginBody = z.object({ email: z.string().trim().toLowerCase().email().max(320), password: z.string().min(1).max(200) }).strict()

async function login(c) {
  if (!secretOf(c.env)) { console.error('[CRITICAL] EXPERT_JWT_SECRET is missing, short, or equal to JWT_SECRET: expert sign-in is refused'); return bad(c, 'Not available.', 503) }
  const p = loginBody.safeParse(await readJson(c)); if (!p.success) return bad(c, GENERIC, 401)
  const supabase = getSupabase(c.env)
  const { data: e, error } = await supabase.from('expert_accounts').select(`${COLS}, password_hash, failed_logins`).eq('email', p.data.email).maybeSingle()
  if (error) throw error
  const hash = e && e.password_hash ? e.password_hash : await getDummy()
  const ok = await bcrypt.compare(p.data.password, hash)
  if (!e || !usable(e)) return bad(c, GENERIC, 401)
  if (e.locked_until && new Date(e.locked_until) > new Date()) return bad(c, 'Too many attempts. Please wait and try again.', 429)
  if (!ok) {
    const fails = (e.failed_logins || 0) + 1
    await supabase.from('expert_accounts').update({ failed_logins: fails, ...(fails >= MAX_FAILS ? { locked_until: new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString(), failed_logins: 0 } : {}) }).eq('id', e.id)
    return bad(c, GENERIC, 401)
  }
  const stage = e.totp_enabled_at ? 'mfa' : 'enroll'
  return c.json({ success: true, data: { stage, token: await mint(c.env, e, 'pending') } })
}

// First sign-in: make a secret (sealed at rest) and show it once. It is not active until a valid code from it is entered.
async function enrollStart(c) {
  const e = c.get('expert')
  if (e.totp_enabled_at) return bad(c, 'Two-factor is already set up. Ask the operator to reset it if you lost your device.', 409)
  const supabase = getSupabase(c.env)
  const secret = totp.newSecret()
  const sealed = await fieldCrypto.sealTaxId(c.env, secret)
  if (!sealed) { console.error('[CRITICAL] expert enrolment: no field encryption key'); return bad(c, 'Not available.', 503) }
  const { error } = await supabase.from('expert_accounts').update({ totp_secret_enc: sealed }).eq('id', e.id).is('totp_enabled_at', null)
  if (error) throw error
  return c.json({ success: true, data: { secret, otpauthUrl: totp.otpauthUrl(secret, e.email) } })
}

const codeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict()
// Second step for both a first sign-in (confirms the new secret) and every later one. A code works once.
async function mfa(c) {
  const e = c.get('expert')
  const p = codeBody.safeParse(await readJson(c)); if (!p.success) return bad(c, GENERIC, 401)
  const supabase = getSupabase(c.env)
  if (e.locked_until && new Date(e.locked_until) > new Date()) return bad(c, 'Too many attempts. Please wait and try again.', 429)
  if (!e.totp_secret_enc) return bad(c, GENERIC, 401)
  const secret = await fieldCrypto.openTaxId(c.env, e.totp_secret_enc)
  const step = secret ? await totp.verifyTotp(secret, p.data.code, { lastStep: e.totp_last_step }) : null
  if (step == null) {
    const { data: row } = await supabase.from('expert_accounts').select('failed_logins').eq('id', e.id).maybeSingle()
    const fails = ((row && row.failed_logins) || 0) + 1
    await supabase.from('expert_accounts').update(fails >= MAX_FAILS ? { failed_logins: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 60e3).toISOString() } : { failed_logins: fails }).eq('id', e.id)
    return bad(c, GENERIC, 401)
  }
  // claim the time step atomically: a replayed code (or two racing requests) finds the step already used
  const claim = supabase.from('expert_accounts')
    .update({ totp_last_step: step, failed_logins: 0, last_login_at: new Date().toISOString(), ...(e.totp_enabled_at ? {} : { totp_enabled_at: new Date().toISOString() }) })
    .eq('id', e.id)
  const { data: won, error } = await (e.totp_last_step == null ? claim.is('totp_last_step', null) : claim.lt('totp_last_step', step)).select('id')
  if (error) throw error
  if (!won || !won.length) return bad(c, GENERIC, 401)
  return c.json({ success: true, data: { token: await mint(c.env, e, 'full'), expert: { name: `${e.display_first_name} ${e.display_initial}.` } } })
}

async function me(c) {
  const e = c.get('expert')
  return c.json({ success: true, data: { name: `${e.display_first_name} ${e.display_initial}.`, email: e.email } })
}
// Sign out everywhere: every token this account holds stops working.
async function logout(c) {
  const e = c.get('expert')
  await getSupabase(c.env).from('expert_accounts').update({ token_version: (e.token_version || 0) + 1 }).eq('id', e.id)
  return c.json({ success: true })
}

module.exports = { login, enrollStart, mfa, me, logout, GENERIC }
