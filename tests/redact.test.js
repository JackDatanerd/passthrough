import { describe, it, expect } from 'vitest'
import { maskEmail, redactPgDetails } from '../src/lib/redact.js'
describe('log redaction', () => {
  it('masks the local part of an address', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@example.com')
    expect(maskEmail('nonsense')).toBe('***')
    expect(maskEmail(undefined)).toBe('')
  })
  it('drops values from Postgres unique-violation details but keeps the column', () => {
    expect(redactPgDetails('Key (email)=(jane@example.com) already exists.')).toBe('Key (email)=([redacted]) already exists.')
    expect(redactPgDetails('Key (user_id, tier)=(abc, FIX) already exists.')).toBe('Key (user_id, tier)=([redacted]) already exists.')
    expect(redactPgDetails(undefined)).toBe('')
  })
  it('also covers err.message that embeds a value', () => {
    expect(redactPgDetails('duplicate key')).toBe('duplicate key')
  })
})
