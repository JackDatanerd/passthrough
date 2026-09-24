import { describe, it, expect } from 'vitest'
import { cleanName, hasSubstance, nameSchema } from '../src/lib/text.js'

describe('cleanName', () => {
  it('collapses whitespace, strips control and invisible filler, keeps real characters', () => {
    expect(cleanName('  Dana \t\n  Whitfield ')).toBe('Dana Whitfield')
    expect(cleanName('Da\u200bna\u0007')).toBe('Dana')
    expect(cleanName('Ann\u2028Lee')).toBe('Ann Lee')
    expect(cleanName(null)).toBe('')
  })
  it('keeps the joiners and directional marks real names need', () => {
    expect(cleanName('می\u200cخواهم')).toContain('\u200c')   // Persian ZWNJ
    expect(cleanName('\u200fمحمد')).toContain('\u200f')       // RLM
  })
})

describe('nameSchema', () => {
  const ok = (v) => nameSchema.safeParse(v)
  it('accepts ordinary names in any script', () => {
    for (const n of ['Dana', 'Åsa Öberg', '李小龍', 'محمد', "O'Brien-Smith Jr.", 'X Æ A-12']) expect(ok(n).success).toBe(true)
  })
  it('returns the cleaned value', () => {
    expect(ok('  Dana \u200b Whitfield\n').data).toBe('Dana Whitfield')
  })
  it('rejects names that are empty once cleaned — including zero-width-only and punctuation/emoji-only', () => {
    for (const n of ['', '   ', '\u200b', '\u200b\u2060\ufeff', '---', '🙂', '\u0000\u0007']) expect(ok(n).success).toBe(false)
  })
  it('judges length on the cleaned value', () => {
    expect(ok('a'.repeat(100)).success).toBe(true)
    expect(ok('a'.repeat(101)).success).toBe(false)
    expect(ok('a'.repeat(100) + '\u200b\u200b').success).toBe(true)
  })
  it('rejects non-strings', () => {
    for (const n of [undefined, null, 5, {}, ['a']]) expect(ok(n).success).toBe(false)
  })
})

describe('hasSubstance', () => {
  it('needs at least one letter or digit', () => {
    expect(hasSubstance('a')).toBe(true)
    expect(hasSubstance('7')).toBe(true)
    expect(hasSubstance('—')).toBe(false)
  })
})
