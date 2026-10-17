import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Cross-cutting infra round 14: adminOnly's runtime parsing must agree with validateEnv / DEPLOYMENT.md —
// a malformed ADMIN_STEP_UP_MINUTES keeps step-up ON at 10 minutes ("0.5" used to floor to 0 = OFF).
describe('ADMIN_STEP_UP_MINUTES parsing', () => {
  const { stepUpMinutes } = require('../src/middleware/adminOnly')
  for (const [raw, want] of [[undefined, 0], ['', 0], ['0', 0], ['10', 10], ['240', 240], ['0.5', 10], ['5.5', 10], ['300', 10], ['10m', 10], ['-1', 10]])
    it(`${JSON.stringify(raw)} -> ${want}`, () => { expect(stepUpMinutes({ ADMIN_STEP_UP_MINUTES: raw })).toBe(want) })
  it('agrees with validateEnv: every value it warns about is ON (10), none is OFF', () => {
    const { validateEnv } = require('../src/lib/env')
    for (const raw of ['0.5', '5.5', '300', '10m']) {
      const warned = validateEnv({ ADMIN_STEP_UP_MINUTES: raw }).warnings.some(w => w.includes('ADMIN_STEP_UP_MINUTES'))
      expect(warned).toBe(true)
      expect(stepUpMinutes({ ADMIN_STEP_UP_MINUTES: raw })).toBe(10)
    }
  })
})

// Cross-cutting infra round 14 (second pass): the other numeric env vars validateEnv polices must also be read strictly at runtime.
describe('strict numeric env at the remaining consumers', () => {
  const { numEnv, NUMERIC_ENV } = require('../src/lib/numEnv')
  it('SCAN_IP_DAILY_CAP: malformed -> default (15-ish), never a silently-off 0 or a 1-scan lockout', () => {
    for (const bad of ['0.5', '-1', '0x10', '1e3', '7d', '100001'])
      expect(numEnv(bad, 15, NUMERIC_ENV.SCAN_IP_DAILY_CAP)).toBe(15)
    expect(numEnv('0', 15, NUMERIC_ENV.SCAN_IP_DAILY_CAP)).toBe(0)
    expect(numEnv('40', 15, NUMERIC_ENV.SCAN_IP_DAILY_CAP)).toBe(40)
  })
  it('PAYOUT_DETAILS_HOLD_HOURS: "0.5" no longer parses as 0 (hold off); only an explicit "0" turns it off', () => {
    const src = require('node:fs').readFileSync(require.resolve('../src/controllers/partners.controller.js'), 'utf8')
    expect(src).not.toMatch(/parseInt\(\s*(?:env\?\.)?(?:COMMISSION_HOLD_DAYS|PAYOUT_DETAILS_HOLD_HOURS|raw)/)
    expect(numEnv('0.5', 48, NUMERIC_ENV.PAYOUT_DETAILS_HOLD_HOURS)).toBe(48)
    expect(numEnv('0', 48, NUMERIC_ENV.PAYOUT_DETAILS_HOLD_HOURS)).toBe(0)
    expect(numEnv('', 48, NUMERIC_ENV.PAYOUT_DETAILS_HOLD_HOURS)).toBe(48)
  })
  it('no consumer of a NUMERIC_ENV name uses parseInt/parseFloat on it', () => {
    const fs = require('node:fs'), path = require('node:path')
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : [])
    const names = Object.keys(NUMERIC_ENV).join('|')
    const re = new RegExp(`(?:parseInt|parseFloat|Number)\\([^)]*\\b(?:${names})\\b`)
    for (const f of walk(path.join(__dirname, '../src'))) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(re)
  })
})

describe('referral / payout numeric env read strictly (round 14, third pass)', () => {
  const { numEnv, NUMERIC_ENV } = require('../src/lib/numEnv')
  const { validateEnv } = require('../src/lib/env')
  it('a blank REFERRAL_MIN_PRICE_PCT / REFERRAL_VELOCITY_ALERT keeps the default; only "0" is off', () => {
    expect(numEnv('', 10, NUMERIC_ENV.REFERRAL_MIN_PRICE_PCT)).toBe(10)
    expect(numEnv('0x10', 10, NUMERIC_ENV.REFERRAL_MIN_PRICE_PCT)).toBe(10)
    expect(numEnv('12.5', 10, NUMERIC_ENV.REFERRAL_MIN_PRICE_PCT)).toBe(12.5)
    expect(numEnv('101', 10, NUMERIC_ENV.REFERRAL_MIN_PRICE_PCT)).toBe(10)
    expect(numEnv('0', 10, NUMERIC_ENV.REFERRAL_VELOCITY_ALERT)).toBe(0)
    expect(numEnv(' ', 10, NUMERIC_ENV.REFERRAL_VELOCITY_ALERT)).toBe(10)
    expect(numEnv('3.7', 10, NUMERIC_ENV.REFERRAL_VELOCITY_ALERT)).toBe(10)
  })
  it('COMMISSION_MIN_PAYOUT_CENTS "2000c" is malformed -> 0', () => {
    expect(numEnv('2000c', 0, NUMERIC_ENV.COMMISSION_MIN_PAYOUT_CENTS)).toBe(0)
    expect(numEnv('2000', 0, NUMERIC_ENV.COMMISSION_MIN_PAYOUT_CENTS)).toBe(2000)
  })
  it('validateEnv warns about them (fractional percent is accepted, fractional alert count is not)', () => {
    const w = k => validateEnv({ [k.n]: k.v }).warnings.some(x => x.includes(`${k.n} is`))
    expect(w({ n: 'REFERRAL_MIN_PRICE_PCT', v: '12.5' })).toBe(false)
    expect(w({ n: 'REFERRAL_MIN_PRICE_PCT', v: '10%' })).toBe(true)
    expect(w({ n: 'REFERRAL_VELOCITY_ALERT', v: '3.7' })).toBe(true)
    expect(w({ n: 'COMMISSION_MIN_PAYOUT_CENTS', v: '2000c' })).toBe(true)
  })
})
