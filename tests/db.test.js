import { describe, it, expect } from 'vitest'
import { isRangeError } from '../src/lib/db.js'

describe('isRangeError', () => {
  it('recognises PostgREST\'s out-of-range answer by code or message, and nothing else', () => {
    expect(isRangeError({ code: 'PGRST103', message: 'x' })).toBe(true)
    expect(isRangeError({ message: 'Requested range not satisfiable' })).toBe(true)
    expect(isRangeError({ code: '23505', message: 'duplicate key' })).toBe(false)
    expect(isRangeError(null)).toBe(false)
    expect(isRangeError(undefined)).toBe(false)
  })
})
