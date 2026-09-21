import { describe, it, expect } from 'vitest'
import { sign, verify } from '../src/lib/jwt.js'

const SECRET = 'unit-test-secret'
const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')

describe('jwt sign/verify', () => {
  it('round-trips a payload', async () => {
    const t = await sign({ userId: 'u1', tokenVersion: 2 }, SECRET, 60)
    const p = await verify(t, SECRET)
    expect(p.userId).toBe('u1')
    expect(p.tokenVersion).toBe(2)
  })
  it('sets exp/iat and produces a 3-part token', async () => {
    const t = await sign({ a: 1 }, SECRET, 60)
    expect(t.split('.')).toHaveLength(3)
    const p = await verify(t, SECRET)
    expect(p.exp - p.iat).toBe(60)
  })
  it('rejects a token signed with a different secret', async () => {
    const t = await sign({ userId: 'u1' }, 'other-secret', 60)
    await expect(verify(t, SECRET)).rejects.toThrow()
  })
  it('rejects a tampered payload (privilege-escalation attempt)', async () => {
    const t = await sign({ userId: 'u1', role: 'USER' }, SECRET, 60)
    const [h, , s] = t.split('.')
    const forged = `${h}.${b64({ userId: 'u1', role: 'ADMIN', exp: 9999999999 })}.${s}`
    await expect(verify(forged, SECRET)).rejects.toThrow()
  })
  it('rejects an expired token with TokenExpiredError (the auth middleware keys off this name)', async () => {
    const t = await sign({ userId: 'u1' }, SECRET, -5)
    let err
    try { await verify(t, SECRET) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.name).toBe('TokenExpiredError')
  })
  it('rejects malformed tokens', async () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '...', 'Bearer x'])
      await expect(verify(bad, SECRET)).rejects.toThrow()
  })
  it('rejects the "alg: none" trick', async () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 'u1', exp: 9999999999 })}.`
    await expect(verify(forged, SECRET)).rejects.toThrow()
  })
})
