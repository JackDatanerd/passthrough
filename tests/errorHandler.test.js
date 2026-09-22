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

  it('turns a malformed/empty JSON body into a 400 (client fault), not a 500', () => {
    for (const body of ['', '{', 'not json', '{"a":']) {
      let err; try { JSON.parse(body) } catch (e) { err = e }
      const res = errorHandler(err, ctx({ NODE_ENV: 'production' }))
      expect(res.status).toBe(400)
      expect(res.body.message).toBe('Invalid request body.')
    }
  })
  it('does not mistake an unrelated SyntaxError for a bad request body', () => {
    const res = errorHandler(new SyntaxError('Unexpected identifier in module'), ctx({ NODE_ENV: 'production' }))
    expect(res.status).toBe(500)
  })
  it("passes Hono's own HTTPException straight through", () => {
    const resp = { status: 418, sentinel: true }
    const res = errorHandler({ message: 'x', getResponse: () => resp }, ctx())
    expect(res).toBe(resp)
  })
  it('an invalid err.status can never crash the handler', () => {
    for (const bad of [0, 200, 302, 999, 'teapot', NaN, null]) {
      const e = new Error('x'); e.status = bad
      expect(errorHandler(e, ctx()).status).toBe(500)
    }
  })
  it('an error that opts in with expose shows its own message on a 4xx even in production', () => {
    const e = new Error('Request body too large.'); e.status = 413; e.expose = true
    const res = errorHandler(e, ctx({ NODE_ENV: 'production' }))
    expect(res.status).toBe(413)
    expect(res.body.message).toBe('Request body too large.')
  })
  it('expose never unmasks a 5xx in production', () => {
    const e = new Error('db password is hunter2'); e.status = 500; e.expose = true
    expect(errorHandler(e, ctx({ NODE_ENV: 'production' })).body.message).toBe('An error occurred.')
  })
  it('logs the cf-ray id with the stack so a log line maps to one request', () => {
    const lines = []; const prev = console.error; console.error = (...a) => lines.push(a.join(' '))
    try { errorHandler(new Error('boom'), { env: {}, req: { header: h => (h === 'cf-ray' ? 'abc123-LHR' : undefined) }, json: (b, s) => ({ b, s }) }) }
    finally { console.error = prev }
    expect(lines.join('\n')).toContain('abc123-LHR')
  })
})

