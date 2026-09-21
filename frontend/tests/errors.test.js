import { describe, it, expect } from 'vitest'
import { getErrorMessage, humanizeField, normalizeBlobError, shouldRetryRequest } from '../src/lib/errors.js'

const axiosErr = (status, data, extra = {}) => ({ isAxiosError: true, response: { status, data }, ...extra })

describe('getErrorMessage', () => {
  it('uses the server message', () => {
    expect(getErrorMessage(axiosErr(400, { message: 'Incorrect password.' }), 'fallback')).toBe('Incorrect password.')
  })
  // The backend sends { message: 'Validation failed', errors: [{field, message}] };
  // every page used to show only the useless "Validation failed".
  it('surfaces Zod field errors instead of "Validation failed"', () => {
    const e = axiosErr(400, { message: 'Validation failed', errors: [{ field: 'newPassword', message: 'String must contain at least 8 character(s)' }] })
    expect(getErrorMessage(e)).toBe('New password: String must contain at least 8 character(s)')
  })
  it('joins up to three field errors', () => {
    const errors = ['a', 'b', 'c', 'd'].map(f => ({ field: f, message: `bad ${f}` }))
    expect(getErrorMessage(axiosErr(400, { message: 'Validation failed', errors }))).toBe('A: bad a · B: bad b · C: bad c')
  })
  it('falls back to the given text when a validation error carries no detail', () => {
    expect(getErrorMessage(axiosErr(400, { message: 'Validation failed' }), 'Check your input.')).toBe('Check your input.')
  })
  it('explains rate limiting and oversized uploads and server faults', () => {
    expect(getErrorMessage(axiosErr(429, {}))).toMatch(/too many requests/i)
    expect(getErrorMessage(axiosErr(413, {}))).toMatch(/too large/i)
    expect(getErrorMessage(axiosErr(503, {}))).toMatch(/server had a problem/i)
  })
  // No response at all used to fall through to e.g. "Login failed." — same text as a wrong password.
  it('distinguishes a dead network from a rejected request', () => {
    expect(getErrorMessage({ isAxiosError: true, request: {}, message: 'Network Error' }, 'Login failed.')).toMatch(/can't reach the server/i)
    expect(getErrorMessage({ isAxiosError: true, code: 'ECONNABORTED' }, 'Login failed.')).toMatch(/timed out/i)
  })
  it('does not blame the network for a bug in our own code', () => {
    expect(getErrorMessage(new TypeError('x is undefined'), 'Something failed.')).toBe('Something failed.')
  })
  it('handles null / undefined', () => {
    expect(getErrorMessage(null, 'fb')).toBe('fb')
    expect(getErrorMessage(undefined)).toMatch(/something went wrong/i)
  })
})

describe('humanizeField', () => {
  it('turns field paths into labels', () => {
    expect(humanizeField('newPassword')).toBe('New password')
    expect(humanizeField('email')).toBe('Email')
    expect(humanizeField('user.first_name')).toBe('First name')
    expect(humanizeField('')).toBe('')
  })
})

describe('normalizeBlobError', () => {
  // axios applies responseType:'blob' to ERROR bodies too, so `err.response.data.code` was undefined.
  it('parses a JSON error body delivered as a Blob, in place', async () => {
    const err = { response: { status: 403, data: new Blob([JSON.stringify({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify first' })]) } }
    await normalizeBlobError(err)
    expect(err.response.data).toEqual({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify first' })
  })
  it('turns a non-JSON Blob into an empty object rather than leaving a Blob', async () => {
    const err = { response: { data: new Blob(['<html>502</html>']) } }
    await normalizeBlobError(err)
    expect(err.response.data).toEqual({})
  })
  it('leaves ordinary errors untouched', async () => {
    const err = { response: { data: { code: 'X' } } }
    await normalizeBlobError(err)
    expect(err.response.data).toEqual({ code: 'X' })
    expect((await normalizeBlobError({})).response).toBeUndefined()
  })
})

describe('shouldRetryRequest', () => {
  const base = { method: 'get', hasResponse: true, alreadyRetried: false }
  it('retries an idempotent GET after a network failure or a 502/503/504', () => {
    expect(shouldRetryRequest({ ...base, hasResponse: false }).retry).toBe(true)
    for (const status of [502, 503, 504]) expect(shouldRetryRequest({ ...base, status }).retry).toBe(true)
  })
  it('never retries non-GET requests (a retried payment/POST could double-charge)', () => {
    for (const method of ['post', 'patch', 'delete', 'put'])
      expect(shouldRetryRequest({ ...base, method, hasResponse: false }).retry).toBe(false)
  })
  it('retries only once', () => {
    expect(shouldRetryRequest({ ...base, hasResponse: false, alreadyRetried: true }).retry).toBe(false)
  })
  it('does not retry client errors or 500s', () => {
    for (const status of [400, 401, 403, 404, 500]) expect(shouldRetryRequest({ ...base, status }).retry).toBe(false)
  })
  it('retries a 429 only when the server says how long (<=5s) to wait', () => {
    expect(shouldRetryRequest({ ...base, status: 429 }).retry).toBe(false)
    expect(shouldRetryRequest({ ...base, status: 429, retryAfterSeconds: 2 })).toEqual({ retry: true, delayMs: 2000 })
    expect(shouldRetryRequest({ ...base, status: 429, retryAfterSeconds: 120 }).retry).toBe(false)
  })
})
