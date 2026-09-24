import { describe, it, expect } from 'vitest'
import { generateShortCode, hashBytes, buildVerificationUrl } from '../src/services/badge.service.js'
import { createWorld } from './helpers/memoryDb.cjs'
import constants from '../src/config/constants.js'

// Zero test coverage previously. generateShortCode's retry-on-collision loop
// and its give-up-after-10-tries failure mode were both unverified.

describe('generateShortCode', () => {
  it('returns a code of the configured length/charset when the first try is unique', async () => {
    const world = createWorld({ scans: [] })
    const code = await generateShortCode(world.db)
    // New pages get the longer code; SHORT_CODE_LENGTH is the legacy length lookups still accept.
    expect(code).toHaveLength(constants.VERIFY_CODE_LENGTH)
    expect(constants.VERIFY_CODE_LENGTH).toBeGreaterThan(constants.SHORT_CODE_LENGTH)
    for (const ch of code) expect(constants.SHORT_CODE_CHARS).toContain(ch)
  })

  it('retries when a generated code already exists, and eventually returns a free one', async () => {
    // Every lookup finds a collision except the caller-controlled 6th attempt.
    let attempt = 0
    const db = {
      from(table) {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                attempt++
                return attempt < 6 ? { data: { id: 'taken' }, error: null } : { data: null, error: null }
              },
            }),
          }),
        }
      },
    }
    const code = await generateShortCode(db)
    expect(attempt).toBe(6)
    expect(typeof code).toBe('string')
  })

  it('gives up after 10 attempts and throws', async () => {
    const db = {
      from() {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'taken' }, error: null }) }) }) }
      },
    }
    await expect(generateShortCode(db)).rejects.toThrow('Could not generate unique short code')
  })

  it('throws immediately (does not retry silently) on a DB error', async () => {
    const db = {
      from() {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'db down' } }) }) }) }
      },
    }
    await expect(generateShortCode(db)).rejects.toThrow('generateShortCode lookup failed: db down')
  })
})

describe('hashBytes', () => {
  it('matches a known SHA-256 vector for the bytes of "abc"', async () => {
    const bytes = new TextEncoder().encode('abc')
    expect(await hashBytes(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('buildVerificationUrl', () => {
  it('builds a /v/:code URL off env.FRONTEND_URL', () => {
    expect(buildVerificationUrl({ FRONTEND_URL: 'https://passthrough.dev' }, 'ABC123'))
      .toBe('https://passthrough.dev/v/ABC123')
  })
})
