import { describe, it, expect } from 'vitest'
import { getDesignTokens } from '../src/services/design.service.js'

// Zero test coverage previously — determinism here matters: the same scan
// must always render with the same palette/fonts (re-downloading a fix
// shouldn't reshuffle its own look), and an unrecognized industry must fall
// back to the full palette rather than silently returning nothing.

describe('getDesignTokens', () => {
  it('is deterministic for the same userId+scanId', () => {
    const a = getDesignTokens('u1', 's1')
    const b = getDesignTokens('u1', 's1')
    expect(a).toEqual(b)
  })

  it('differs (in general) for a different scanId', () => {
    const seen = new Set()
    for (let i = 0; i < 20; i++) seen.add(getDesignTokens('u1', `s${i}`).palette.id)
    expect(seen.size).toBeGreaterThan(1)
  })

  it('treats a missing/anonymous userId consistently ("anon")', () => {
    const a = getDesignTokens(null, 's1')
    const b = getDesignTokens(undefined, 's1')
    expect(a).toEqual(b)
  })

  it('an unrecognized industry falls back to the full palette set, not an empty one', () => {
    const tokens = getDesignTokens('u1', 's1', 'not-a-real-industry')
    expect(tokens.palette).toBeTruthy()
    expect(tokens.fonts).toBeTruthy()
  })

  it('a recognized industry only ever picks from its allowed palette subset', () => {
    const allowedHealthcare = ['clinical', 'slate', 'teal', 'ocean', 'midnight']
    for (let i = 0; i < 20; i++) {
      const tokens = getDesignTokens('u1', `s${i}`, 'healthcare')
      expect(allowedHealthcare).toContain(tokens.palette.id)
    }
  })

  it('always returns a palette with the expected color keys and a font pair', () => {
    const { palette, fonts } = getDesignTokens('u1', 's1')
    expect(palette).toMatchObject({ id: expect.any(String), bg: expect.any(String), primary: expect.any(String), accent: expect.any(String), text: expect.any(String) })
    expect(fonts).toMatchObject({ id: expect.any(String), heading: expect.any(String), body: expect.any(String) })
  })
})
