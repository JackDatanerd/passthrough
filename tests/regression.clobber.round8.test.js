import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { readFileSync } from 'fs'
const require = createRequire(import.meta.url)

// Scan/ATS round 8: three commits from different sessions each overwrote a shared file with a stale copy and silently
// removed what an earlier commit had added. These pin the pieces so a stale overlay fails CI instead of production.
describe('shared files keep what other rounds added', () => {
  it('constants.js still has the per-currency price table checkout depends on', () => {
    const c = require('../src/config/constants.js')
    for (const fn of ['isSupportedCurrency', 'priceTable', 'activeCurrency']) expect(typeof c[fn]).toBe('function')
    expect(c.isSupportedCurrency({ PAYSTACK_CURRENCY: 'USD' })).toBe(true)
  })
  it('rateLimiter.js still exports forgetTrustedDevices (auth.controller calls it on credential changes)', () => {
    expect(typeof require('../src/middleware/rateLimiter.js').forgetTrustedDevices).toBe('function')
  })
  it('App.jsx still routes /employer/preferences', () => {
    const app = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8')
    expect(app).toMatch(/path="\/employer\/preferences"/)
    expect(app).toMatch(/import\('\.\/pages\/EmployerLeadPreferences'\)/)
  })
})
