import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import errorHandler from '../src/middleware/errorHandler.js'
import adminOnly from '../src/middleware/adminOnly.js'
import bodyLimit, { stripNul } from '../src/middleware/bodyLimit.js'
import uploadResume from '../src/middleware/upload.js'
import sessions from '../src/lib/sessions.js'
import { validateEnv } from '../src/lib/env.js'
import { numEnv } from '../src/lib/numEnv.js'

let realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr })

describe('strict numeric env (round 11, B1)', () => {
  it('numEnv accepts only whole plain numbers in range', () => {
    expect(numEnv('3600', 1, { min: 60 })).toBe(3600)
    for (const bad of ['7d', '1h', '25s', '3e5', '-5', 'abc', '10m']) expect(numEnv(bad, 99, { min: 1 })).toBe(99)
  })
  it('a "7d" JWT lifetime falls back to 7 days, not 7 seconds', () => {
    expect(sessions.tokenLifetimeSeconds({ JWT_EXPIRES_IN_SECONDS: '7d' }, null)).toBe(604800)
    expect(sessions.tokenLifetimeSeconds({ JWT_EXPIRES_IN_SECONDS: '3600' }, null)).toBe(3600)
  })
  it('a malformed admin session cap keeps the default cap ON; only 0 disables', () => {
    const ctx = env => ({ env, get: () => Date.now() - 500 * 3600 * 1000 })
    for (const v of ['24h', 'abc', '-1']) expect(adminOnly.adminSessionTooOld(ctx({ ADMIN_SESSION_MAX_HOURS: v }))).toBe(true)
    expect(adminOnly.adminSessionTooOld(ctx({ ADMIN_SESSION_MAX_HOURS: '0' }))).toBe(false)
  })
  it('a malformed step-up value keeps step-up ON; unset/0 is off', () => {
    expect(adminOnly.stepUpMinutes({ ADMIN_STEP_UP_MINUTES: '10m' })).toBe(10)
    expect(adminOnly.stepUpMinutes({ ADMIN_STEP_UP_MINUTES: '15' })).toBe(15)
    expect(adminOnly.stepUpMinutes({ ADMIN_STEP_UP_MINUTES: '999' })).toBe(10)   // out of range = malformed (round 14): same answer validateEnv's warning gives
    expect(adminOnly.stepUpMinutes({ ADMIN_STEP_UP_MINUTES: '0.5' })).toBe(10)   // used to floor to 0 = OFF
    expect(adminOnly.stepUpMinutes({})).toBe(0)
    expect(adminOnly.stepUpMinutes({ ADMIN_STEP_UP_MINUTES: '0' })).toBe(0)
  })
  it('validateEnv warns about each malformed numeric var', () => {
    const w = validateEnv({ ADMIN_SESSION_MAX_HOURS: '24h', ADMIN_STEP_UP_MINUTES: '10m', JWT_EXPIRES_IN_SECONDS: '7d', SUPABASE_TIMEOUT_MS: '25s', RATE_LIMIT_DO_TIMEOUT_MS: '3s' }).warnings.join('\n')
    for (const k of ['ADMIN_SESSION_MAX_HOURS', 'ADMIN_STEP_UP_MINUTES', 'JWT_EXPIRES_IN_SECONDS', 'SUPABASE_TIMEOUT_MS', 'RATE_LIMIT_DO_TIMEOUT_MS']) expect(w).toContain(`${k} is`)
    expect(validateEnv({ ADMIN_STEP_UP_MINUTES: '10', JWT_EXPIRES_IN_SECONDS: '604800' }).warnings.join()).not.toContain('must be a plain number')
  })
})

describe('NUL in user text (round 11, B2)', () => {
  it('stripNul cleans nested strings and keys', () => {
    expect(stripNul({ a: 'x\u0000y', 'k\u0000': ['\u0000z', 1, null] })).toEqual({ a: 'xy', k: ['z', 1, null] })
  })
  it('the JSON reader strips NUL', async () => {
    let seen
    const c = { req: { json: async () => ({ jobDescriptionText: 'a\u0000b' }), method: 'GET', header: () => undefined } }
    await bodyLimit()(c, async () => { seen = await c.req.json() })
    expect(seen.jobDescriptionText).toBe('ab')
  })
  it('multipart text fields drop NUL', async () => {
    const fd = new FormData(); fd.set('jobDescriptionText', 'dev\u0000 role'); fd.set('brainDumpText', 'x\u0000'); fd.set('contactName', 'A\u0000nn')
    const req = new Request('http://x/api/scan', { method: 'POST', body: fd })
    const store = {}
    const ctx = { req: { header: n => req.headers.get(n), raw: req }, set: (k, v) => { store[k] = v }, json: (b, s) => ({ b, s }) }
    await uploadResume(ctx, async () => {})
    expect(store.formFields.jobDescriptionText).toBe('dev role')
    expect(store.formFields.brainDumpText).toBe('x')
    expect(store.formFields.contactName).toBe('Ann')
  })
  it('NUL data exceptions answer 400, not 500', () => {
    const ctx = { env: { NODE_ENV: 'production' }, req: { header: () => 'ray' }, json: (b, s) => ({ b, s }) }
    for (const code of ['22021', '22P05']) expect(errorHandler({ code, message: 'm' }, ctx).s).toBe(400)
    expect(errorHandler({ code: '22P02', message: 'uuid' }, ctx).s).toBe(500)
    expect(errorHandler({ code: '23503', message: 'fk' }, ctx).s).toBe(500)
  })
})
