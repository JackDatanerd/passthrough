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


describe('jwt sign/verify — Auth round 1 hardening', () => {
  it('rejects an exp that is missing, non-numeric, or NaN, even with a valid signature', async () => {
    for (const badPayload of [{ userId: 'u1' }, { userId: 'u1', exp: 'soon' }, { userId: 'u1', exp: NaN }]) {
      const header = b64({ alg: 'HS256', typ: 'JWT' })
      const payload = b64(badPayload)
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
      const sigB64 = Buffer.from(sig).toString('base64url')
      const t = `${header}.${payload}.${sigB64}`
      await expect(verify(t, SECRET)).rejects.toBeTruthy()
    }
  })
  it('rejects an alg other than HS256, even with a genuinely valid HMAC signature for that header', async () => {
    const header = b64({ alg: 'HS384', typ: 'JWT' })
    const payload = b64({ userId: 'u1', exp: 9999999999 })
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`))
    const t = `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`
    await expect(verify(t, SECRET)).rejects.toBeTruthy()
  })
  it('sign() refuses a non-finite lifetime rather than minting a token with exp:null', async () => {
    for (const bad of [undefined, NaN, Infinity, 'x'])
      await expect(sign({ userId: 'u1' }, SECRET, bad)).rejects.toThrow(TypeError)
  })
  it('round-trips a token that carries sid alongside userId/tokenVersion', async () => {
    const t = await sign({ userId: 'u1', tokenVersion: 2, sid: 'abc-123' }, SECRET, 60)
    const p = await verify(t, SECRET)
    expect(p.sid).toBe('abc-123')
  })
  it('rejects a header that is not valid JSON, or not an object', async () => {
    for (const bad of ['not-base64-json!!!', b64([1, 2, 3]), b64('a string')]) {
      const payload = b64({ userId: 'u1', exp: 9999999999 })
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${bad}.${payload}`))
      const t = `${bad}.${payload}.${Buffer.from(sig).toString('base64url')}`
      await expect(verify(t, SECRET)).rejects.toBeTruthy()
    }
  })
  it('an old-format token with no sid still verifies fine (pre-0047 tokens keep working)', async () => {
    const t = await sign({ userId: 'u1', tokenVersion: 1 }, SECRET, 60)
    const p = await verify(t, SECRET)
    expect(p.sid).toBeUndefined()
  })
})
