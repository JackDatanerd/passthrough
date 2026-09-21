import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import errorHandler from '../src/middleware/errorHandler.js'

const ctx = (env = {}) => ({ env, json: (body, status) => ({ body, status }) })
let realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr })

describe('errorHandler', () => {
  it('turns a ZodError into 400 with a per-field errors[] (the API contract the client relies on)', () => {
    const err = { name: 'ZodError', errors: [{ path: ['newPassword'], message: 'String must contain at least 8 character(s)' }, { path: ['user', 'email'], message: 'Invalid email' }] }
    const res = errorHandler(err, ctx())
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Validation failed')
    expect(res.body.errors).toEqual([
      { field: 'newPassword', message: 'String must contain at least 8 character(s)' },
      { field: 'user.email', message: 'Invalid email' },
    ])
  })
  it('maps a unique-violation (23505) to 409', () => {
    const res = errorHandler({ code: '23505', message: 'dup' }, ctx())
    expect(res.status).toBe(409)
  })
  it('hides internal error text in production but shows it in dev', () => {
    const err = new Error('relation "users" does not exist')
    expect(errorHandler(err, ctx({ NODE_ENV: 'production' })).body.message).toBe('An error occurred.')
    expect(errorHandler(err, ctx({ NODE_ENV: 'development' })).body.message).toBe('relation "users" does not exist')
  })
  it('defaults to 500 and honours an explicit err.status', () => {
    expect(errorHandler(new Error('x'), ctx()).status).toBe(500)
    const e = new Error('teapot'); e.status = 418
    expect(errorHandler(e, ctx()).status).toBe(418)
  })
  it('never leaks a stack trace', () => {
    const res = errorHandler(new Error('boom'), ctx())
    expect(JSON.stringify(res.body)).not.toContain('at ')
  })
})
