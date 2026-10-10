import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const core = require('../src/lib/rateLimitCore.js')
const { render } = require('../src/templates/emails.js')

const memStore = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } } }

describe('Auth round 6 — lockout is not re-armed by failures while locked (B3)', () => {
  it('keeps the original end of a running lock', async () => {
    const store = memStore(), key = 'rl:lockout:a@b.c'
    let t = 1_000_000
    for (let i = 0; i < 8; i++) await core.lockoutFail(store, key, i % 2 ? '2.2.2.2' : '1.1.1.1', 2, t += 1000)
    const lockEnd = t + core.LOCKOUT_MINUTES * 60 * 1000
    const later = t + 14 * 60 * 1000
    const r = await core.lockoutFail(store, key, '1.1.1.1', 2, later)
    expect(r.justLocked).toBe(false)
    const st = await core.lockoutCheck(store, key, later)
    expect(st.locked).toBe(true)
    expect(st.retryAfterSeconds).toBe(Math.ceil((lockEnd - later) / 1000))   // ~60s, not 900s
  })
  it('still locks normally, alerts once, and unlocks on schedule', async () => {
    const store = memStore(), key = 'k'
    let t = 5_000_000, just = 0
    for (let i = 0; i < 9; i++) { const r = await core.lockoutFail(store, key, i % 2 ? 'b' : 'a', 2, t += 1000); if (r.justLocked) just++ }
    expect(just).toBe(1)
    expect((await core.lockoutCheck(store, key, t + 16 * 60 * 1000)).locked).toBe(false)
  })
})

describe('Auth round 6 — link lifetimes in emails come from the constants (B8)', () => {
  const constants = require('../src/config/constants.js')
  const email = require('../src/services/email.service.js')
  it('templates carry a placeholder, not a typed-in number', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/templates/emails.js'), 'utf8')
    expect(src).not.toMatch(/expires in (24 hours|1 hour)/)
    expect((src.match(/expires in \{\{EXPIRY\}\}/g) || []).length).toBe(3)
  })
  it('lockout email no longer tells people to wait for the lock before resetting', () => {
    const html = render('account_lockout_alert', { NAME: 'Ada', LOCKOUT_MINUTES: '15' })
    expect(html).not.toMatch(/once the lock clears/)
    expect(html).toMatch(/Forgot password/)
  })
  it('constants are what the senders pass', () => {
    expect(constants.EMAIL_VERIFY_EXPIRY_HOURS).toBe(24)
    expect(typeof email.sendVerification).toBe('function')
  })
})

describe('Auth round 6 — migration 0066 (B4)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0066_auth_round6.sql'), 'utf8')
  it('indexes the three unauthenticated lookup columns, idempotently', () => {
    for (const col of ['reset_token', 'email_verify_token', 'email_change_done_token'])
      expect(sql).toMatch(new RegExp(`create index if not exists idx_users_${col}\\s+on users \\(${col}\\)`))
  })
})
