import { describe, it, expect } from 'vitest'
import { passwordProblem, PASSWORD_MAX_BYTES } from '../src/lib/passwordRules.js'

// Mirrors auth.controller.js's passwordSchema: every rule is judged on the NFKC-normalized password
// (Auth round 4, G2).
describe('passwordProblem — NFKC', () => {
  it('counts a combining-mark spelling the way the server will', () => {
    expect(passwordProblem('e\u0301'.repeat(36))).toBeNull()                  // 108 raw bytes, 72 normalized
    expect(passwordProblem('e\u0301'.repeat(37))).toMatch(/too long/i)        // 74 normalized bytes
  })
  it('denies a full-width spelling of a common password', () => {
    expect(passwordProblem('\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44\uff11\uff12\uff13')).toMatch(/too common/i)
  })
  it('counts length after normalizing', () => {
    expect(passwordProblem('\uff11\uff12\uff13\uff14')).toMatch(/at least 8/)  // four full-width digits
  })
  it('keeps the plain rules', () => {
    expect(passwordProblem('')).toMatch(/required/i)
    expect(passwordProblem('Password123')).toMatch(/too common/i)
    expect(passwordProblem('x'.repeat(PASSWORD_MAX_BYTES + 1))).toMatch(/too long/i)
    expect(passwordProblem('correct-horse-9', 'a@b.co')).toBeNull()
  })
})
