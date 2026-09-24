import { describe, it, expect } from 'vitest'
import {
  STATUS, REVOKE_REASON, CODE_RE,
  normalizeCode, isPlausibleCode, isBotUserAgent, visitorKey,
  revokeVerification, restoreVerification, recordTombstones, SHA256_RE,
} from '../src/lib/verification.js'
import { createWorld } from './helpers/memoryDb.cjs'

// lib/verification.js had zero direct test coverage despite encoding the
// entire owner-vs-admin revocation authority model (an owner's unpublish
// must never be undoable by anyone but themself, and must never override a
// refund/dispute/admin takedown) purely in SQL filter chains. That's exactly
// the kind of logic a refactor could silently invert without any test
// noticing.

describe('normalizeCode / isPlausibleCode', () => {
  it('normalizeCode trims and uppercases', () => {
    expect(normalizeCode('  abc123  ')).toBe('ABC123')
    expect(normalizeCode(null)).toBe('')
    expect(normalizeCode(undefined)).toBe('')
  })
  it('isPlausibleCode matches only the configured charset/length', () => {
    const valid = 'A'.repeat(CODE_RE.source.match(/\{(\d+)\}/)[1])
    expect(isPlausibleCode(valid)).toBe(true)
    expect(isPlausibleCode('')).toBe(false)
    expect(isPlausibleCode('not-a-real-code!!')).toBe(false)
  })
})

describe('isBotUserAgent', () => {
  it('flags known crawlers/monitors/CLI clients', () => {
    for (const ua of ['Googlebot/2.1', 'curl/8.0', 'python-requests/2.31', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding'])
      expect(isBotUserAgent(ua)).toBe(true)
  })
  it('does not flag an ordinary browser UA', () => {
    expect(isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36')).toBe(false)
  })
  it('treats an empty/missing UA as not a browser (bot=true)', () => {
    expect(isBotUserAgent('')).toBe(true)
    expect(isBotUserAgent(undefined)).toBe(true)
  })
})

describe('visitorKey', () => {
  it('hashes ip+ua into a stable, namespaced key that never contains the raw IP/UA', async () => {
    const key = await visitorKey('ABC123', '203.0.113.5', 'Mozilla/5.0')
    expect(key.startsWith('vv:ABC123:')).toBe(true)
    expect(key).not.toContain('203.0.113.5')
    expect(key).not.toContain('Mozilla')
  })
  it('is deterministic for the same inputs and differs for different ones', async () => {
    const a = await visitorKey('ABC123', '1.2.3.4', 'ua')
    const b = await visitorKey('ABC123', '1.2.3.4', 'ua')
    const c = await visitorKey('ABC123', '1.2.3.5', 'ua')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('revokeVerification', () => {
  it('returns false without touching the DB when scanId is falsy', async () => {
    const world = createWorld({ scans: [] })
    expect(await revokeVerification(world.db, null, REVOKE_REASON.OWNER)).toBe(false)
    expect(world.calls.length).toBe(0)
  })

  it('OWNER reason only revokes an ACTIVE row, and reports false when nothing changed', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.ADMIN }] })
    const changed = await revokeVerification(world.db, 's1', REVOKE_REASON.OWNER)
    expect(changed).toBe(false)
    // must not have overwritten the stronger admin revocation
    expect(world.t.scans[0].verification_revoked_reason).toBe(REVOKE_REASON.ADMIN)
  })

  it('OWNER reason revokes when the row is currently ACTIVE', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.ACTIVE }] })
    const changed = await revokeVerification(world.db, 's1', REVOKE_REASON.OWNER)
    expect(changed).toBe(true)
    expect(world.t.scans[0]).toMatchObject({ verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.OWNER })
  })

  it('REFUND/DISPUTE/ADMIN reasons revoke regardless of current status (no ACTIVE gate)', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.OWNER }] })
    const changed = await revokeVerification(world.db, 's1', REVOKE_REASON.REFUND)
    expect(changed).toBe(true)
    expect(world.t.scans[0].verification_revoked_reason).toBe(REVOKE_REASON.REFUND)
  })

  // SECTION 7/8 AUDIT FIX (bug): a redelivered webhook (or a repeated admin
  // action) calling this again with the SAME reason on an already-revoked
  // row used to still report changed:true and silently re-stamp
  // verification_revoked_at to now() — drifting the publicly-displayed
  // revocation date forward for no real reason. It must now be a no-op.
  it('is idempotent: revoking again with the SAME reason does not touch the row', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.REFUND, verification_revoked_at: '2026-01-01T00:00:00.000Z' }] })
    const changed = await revokeVerification(world.db, 's1', REVOKE_REASON.REFUND, new Date('2026-06-01T00:00:00.000Z'))
    expect(changed).toBe(false)
    expect(world.t.scans[0].verification_revoked_at).toBe('2026-01-01T00:00:00.000Z')
    expect(world.calls.some(c => c.op === 'update')).toBe(false)
  })

  // A DIFFERENT non-OWNER reason must still win even though it's already
  // revoked — only the same-reason case is a no-op.
  it('a different non-OWNER reason still overwrites an existing non-OWNER revocation', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.DISPUTE, verification_revoked_at: '2026-01-01T00:00:00.000Z' }] })
    const changed = await revokeVerification(world.db, 's1', REVOKE_REASON.ADMIN, new Date('2026-06-01T00:00:00.000Z'))
    expect(changed).toBe(true)
    expect(world.t.scans[0]).toMatchObject({ verification_revoked_reason: REVOKE_REASON.ADMIN, verification_revoked_at: '2026-06-01T00:00:00.000Z' })
  })

  it('throws on a DB error rather than reporting false silently', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.ACTIVE }] })
    world.failNext('scans', 'update', { message: 'db down' })
    await expect(revokeVerification(world.db, 's1', REVOKE_REASON.OWNER)).rejects.toMatchObject({ message: 'db down' })
  })
})

describe('restoreVerification', () => {
  it('the owner (asAdmin=false) can only lift their OWN (OWNER-reason) revocation', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.ADMIN }] })
    const changed = await restoreVerification(world.db, 's1', { asAdmin: false })
    expect(changed).toBe(false)
    expect(world.t.scans[0].verification_status).toBe(STATUS.REVOKED)
  })

  it('the owner can lift their own OWNER-reason revocation', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.OWNER }] })
    const changed = await restoreVerification(world.db, 's1', { asAdmin: false })
    expect(changed).toBe(true)
    expect(world.t.scans[0]).toMatchObject({ verification_status: STATUS.ACTIVE, verification_revoked_at: null, verification_revoked_reason: null })
  })

  it('an admin can lift ANY revocation reason', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.REVOKED, verification_revoked_reason: REVOKE_REASON.REFUND }] })
    const changed = await restoreVerification(world.db, 's1', { asAdmin: true })
    expect(changed).toBe(true)
    expect(world.t.scans[0].verification_status).toBe(STATUS.ACTIVE)
  })

  it('is a no-op (returns false) on an already-ACTIVE row', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_status: STATUS.ACTIVE }] })
    expect(await restoreVerification(world.db, 's1', { asAdmin: true })).toBe(false)
  })

  it('returns false without touching the DB when scanId is falsy', async () => {
    const world = createWorld({ scans: [] })
    expect(await restoreVerification(world.db, undefined)).toBe(false)
    expect(world.calls.length).toBe(0)
  })
})

// ── Round 3 ────────────────────────────────────────────────────────────────
describe('round 3 — code shape, normalisation, tombstones', () => {
  it('CODE_RE accepts the legacy 6-character code and the new 10-character one, and nothing in between', () => {
    expect(isPlausibleCode('AB3XY7')).toBe(true)
    expect(isPlausibleCode('AB3XY7K9MN')).toBe(true)
    for (const bad of ['AB3XY', 'AB3XY7K', 'AB3XY7K9M', 'AB3XY7K9MNP', 'ab3xy7', 'AB3XY0', 'AB3XYI'])
      expect(isPlausibleCode(bad)).toBe(false)
  })
  it('normalizeCode never lets a Unicode look-alike fold into a code character', () => {
    expect(normalizeCode(' ab3xy7 ')).toBe('AB3XY7')
    expect(normalizeCode('ſb3xy7')).toBe('')          // U+017F uppercases to "S" — must not
    expect(normalizeCode('ab3xy7\n')).toBe('AB3XY7')  // surrounding whitespace is still trimmed
    expect(normalizeCode('ab3 xy7')).toBe('')         // inner whitespace is not a code
    expect(isPlausibleCode(normalizeCode('ﬁ23456'))).toBe(false)
  })
  it('SHA256_RE is exactly 64 lowercase hex characters', () => {
    expect(SHA256_RE.test('a'.repeat(64))).toBe(true)
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '']) expect(SHA256_RE.test(bad)).toBe(false)
  })
  it('recordTombstones upserts each distinct non-empty code once, ignoring duplicates', async () => {
    const seen = []
    const db = { from: t => ({ upsert: async (rows, opts) => { seen.push({ t, rows, opts }); return { error: null } } }) }
    await recordTombstones(db, ['AB3XY7', null, 'AB3XY7', '', 'CD4ZW8'])
    expect(seen).toHaveLength(1)
    expect(seen[0].t).toBe('verification_tombstones')
    expect(seen[0].rows).toEqual([{ code: 'AB3XY7' }, { code: 'CD4ZW8' }])
    expect(seen[0].opts).toMatchObject({ onConflict: 'code', ignoreDuplicates: true })
  })
  it('recordTombstones does nothing for no codes, and NEVER throws (the deletion it follows already committed)', async () => {
    let called = false
    await recordTombstones({ from: () => { called = true } }, [null, ''])
    expect(called).toBe(false)
    const real = console.error; console.error = () => {}
    await recordTombstones({ from: () => ({ upsert: async () => ({ error: { message: 'relation does not exist' } }) }) }, ['AB3XY7'])
    await recordTombstones({ from: () => { throw new Error('boom') } }, ['AB3XY7'])
    console.error = real
  })
})
