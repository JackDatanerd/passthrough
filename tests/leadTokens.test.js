import { describe, it, expect } from 'vitest'
import { signLeadToken, verifyLeadToken, leadLinkSecrets } from '../src/lib/leadTokens.js'

const SECRET = 'a-secret-that-is-long-enough-for-hmac-000'

describe('leadTokens', () => {
  it('round-trips an address (lowercased) for the purpose it was signed for', async () => {
    const t = await signLeadToken(SECRET, 'confirm', '  Dana@Acme.COM ')
    expect(await verifyLeadToken(SECRET, 'confirm', t)).toBe('dana@acme.com')
  })
  it('a token is only valid for its own purpose, secret and address', async () => {
    const t = await signLeadToken(SECRET, 'confirm', 'dana@acme.com')
    expect(await verifyLeadToken(SECRET, 'remove', t)).toBeNull()
    expect(await verifyLeadToken('another-secret-that-is-long-enough-00', 'confirm', t)).toBeNull()
    const other = await signLeadToken(SECRET, 'confirm', 'eve@evil.com')
    // splice Eve's address onto Dana's signature
    expect(await verifyLeadToken(SECRET, 'confirm', other.split('.')[0] + '.' + t.split('.')[1])).toBeNull()
  })
  it('rejects malformed input without throwing', async () => {
    for (const bad of [undefined, null, 42, '', '.', 'a', 'a.b.c', '%%%.%%%', '####.####', 'YQ.', '.YQ']) {
      expect(await verifyLeadToken(SECRET, 'confirm', bad)).toBeNull()
    }
    expect(await verifyLeadToken(undefined, 'confirm', 'YQ.YQ')).toBeNull()
    expect(await verifyLeadToken(SECRET, 'bogus', 'YQ.YQ')).toBeNull()
  })
  it('refuses to sign without a secret or with an unknown purpose (a silent unsigned link would be worse)', async () => {
    await expect(signLeadToken('', 'confirm', 'a@b.co')).rejects.toThrow('JWT_SECRET')
    await expect(signLeadToken(SECRET, 'delete', 'a@b.co')).rejects.toThrow('purpose')
  })
  it('handles non-ASCII local parts', async () => {
    const t = await signLeadToken(SECRET, 'remove', 'josé@acme.com')
    expect(await verifyLeadToken(SECRET, 'remove', t)).toBe('josé@acme.com')
  })
})

describe('leadLinkSecrets and multi-secret verification', () => {
  const A = 'secret-a-secret-a-secret-a-secret-a-000', B = 'secret-b-secret-b-secret-b-secret-b-000', C = 'secret-c-secret-c-secret-c-secret-c-000'
  it('signs with LEAD_LINK_SECRET, else JWT_SECRET; verifies against every configured key, de-duplicated', () => {
    expect(leadLinkSecrets({ JWT_SECRET: A })).toEqual({ sign: A, verify: [A] })
    expect(leadLinkSecrets({ JWT_SECRET: A, LEAD_LINK_SECRET: B })).toEqual({ sign: B, verify: [B, A] })
    expect(leadLinkSecrets({ JWT_SECRET: A, LEAD_LINK_SECRET: B, LEAD_LINK_SECRET_PREVIOUS: C })).toEqual({ sign: B, verify: [B, C, A] })
    expect(leadLinkSecrets({ JWT_SECRET: A, LEAD_LINK_SECRET: A })).toEqual({ sign: A, verify: [A] })
    expect(leadLinkSecrets({})).toEqual({ sign: undefined, verify: [] })
    expect(leadLinkSecrets(undefined).verify).toEqual([])
  })
  it('accepts a token signed by any listed secret, rejects one signed by none', async () => {
    const tok = await signLeadToken(C, 'remove', 'dana@acme.com')
    expect(await verifyLeadToken([A, B, C], 'remove', tok)).toBe('dana@acme.com')
    expect(await verifyLeadToken([A, B], 'remove', tok)).toBeNull()
    expect(await verifyLeadToken([], 'remove', tok)).toBeNull()
    expect(await verifyLeadToken([undefined, ''], 'remove', tok)).toBeNull()
    expect(await verifyLeadToken([A, C], 'confirm', tok)).toBeNull()   // purpose is still bound
  })
})
