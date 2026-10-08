import { describe, it, expect } from 'vitest'
import { cleanName, cleanStrangerText, cleanNotes, firstNameOf, hasSubstance, nameSchema } from '../src/lib/text.js'

describe('cleanName', () => {
  it('collapses whitespace, strips control and invisible filler, keeps real characters', () => {
    expect(cleanName('  Dana \t\n  Whitfield ')).toBe('Dana Whitfield')
    expect(cleanName('Da\u200bna\u0007')).toBe('Dana')
    expect(cleanName('Ann\u2028Lee')).toBe('Ann Lee')
    expect(cleanName(null)).toBe('')
  })
  it('strips Unicode tag characters and deprecated format controls (invisible, above U+FFFF too)', () => {
    expect(cleanName('Ann' + String.fromCodePoint(0xe0041, 0xe0042) + ' Lee')).toBe('Ann Lee')
    expect(cleanName('Ann\u206a\u2065 Lee\ufff9')).toBe('Ann Lee')
    expect(hasSubstance(cleanName(String.fromCodePoint(0xe0041)))).toBe(false)
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

// Independent audit round 9 (Section 5): one shared list. Account names used to lack the bidi
// override and Hangul-filler entries the employer-leads controller already had.
describe('shared invisible / direction-changing characters', () => {
  it('strips bidi embedding and override controls from account names', () => {
    expect(cleanName('Dana\u202eevil')).toBe('Danaevil')
    expect(cleanName('A\u202a\u202b\u202c\u202dB')).toBe('AB')
  })
  it('rejects a name made only of Hangul fillers, Khmer vowels or a grapheme joiner', () => {
    for (const n of ['\u3164', '\u115f\u1160', '\uffa0', '\u17b4\u17b5', '\u034f']) expect(nameSchema.safeParse(n).success).toBe(false)
  })
  it('still keeps LRM / RLM / ALM for account names (Persian, Arabic, Hebrew)', () => {
    expect(cleanName('\u200fמשה')).toContain('\u200f')
    expect(cleanName('\u061cمحمد')).toContain('\u061c')
  })
  it('drops them for text typed by a stranger', () => {
    expect(cleanStrangerText('Da\u200f\u061c\u200ena')).toBe('Dana')
    expect(cleanStrangerText('  a \n b ')).toBe('a b')
  })
  it('cleanNotes keeps line breaks but removes dangerous characters', () => {
    expect(cleanNotes(' line1\nline2\u202e\u0007 ')).toBe('line1\nline2')
  })
})

describe('firstNameOf (the public verification page)', () => {
  it('returns the cleaned first word', () => {
    expect(firstNameOf('  Dana   Whitfield ')).toBe('Dana')
    expect(firstNameOf('\u202eDana Whitfield')).toBe('Dana')
  })
  it('is null when there is no real word', () => {
    for (const v of [null, undefined, '', '   ', '\u200b', '\u3164', '--- x', 42]) expect(firstNameOf(v)).toBeNull()
  })
})
