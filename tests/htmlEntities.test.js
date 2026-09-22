import { describe, it, expect } from 'vitest'
import { decodeHtmlEntities } from '../src/lib/htmlEntities.js'

// jd.parser.js and ats.service.js both depend on this to stop stray
// &nbsp;/&amp; entities from becoming phantom "missing keywords" — it had no
// test file at all.

describe('decodeHtmlEntities', () => {
  it('returns non-strings and strings without "&" unchanged', () => {
    expect(decodeHtmlEntities(null)).toBe(null)
    expect(decodeHtmlEntities(undefined)).toBe(undefined)
    expect(decodeHtmlEntities(42)).toBe(42)
    expect(decodeHtmlEntities('plain text')).toBe('plain text')
  })

  it('decodes the named entities that matter for JD text', () => {
    expect(decodeHtmlEntities('Kubernetes&nbsp;Docker')).toBe('Kubernetes Docker')
    expect(decodeHtmlEntities('R&amp;D')).toBe('R&D')
    expect(decodeHtmlEntities('AT&amp;T &mdash; hiring')).toBe('AT&T - hiring')
    expect(decodeHtmlEntities('&ldquo;quoted&rdquo;')).toBe('"quoted"')
    expect(decodeHtmlEntities('5&deg;C &plusmn; 2')).toBe('5°C ± 2')
  })

  it('is case-insensitive on the entity name', () => {
    expect(decodeHtmlEntities('R&AMP;D')).toBe('R&D')
    expect(decodeHtmlEntities('Tom&Nbsp;Jones')).toBe('Tom Jones')
  })

  it('decodes numeric (decimal and hex) references', () => {
    expect(decodeHtmlEntities('&#65;&#66;&#67;')).toBe('ABC')
    expect(decodeHtmlEntities('&#x41;&#x42;&#x43;')).toBe('ABC')
  })

  it('replaces an unrecognized-but-well-formed entity with a space, not junk text', () => {
    expect(decodeHtmlEntities('foo&notarealentity;bar')).toBe('foo bar')
  })

  it('rejects unsafe code points (NUL, surrogate range, out of range) with a space', () => {
    expect(decodeHtmlEntities('&#0;')).toBe(' ')
    expect(decodeHtmlEntities('&#xD800;')).toBe(' ')
    expect(decodeHtmlEntities('&#9999999;')).toBe(' ')  // 7 digits (regex max), still > 0x10ffff
  })

  it('collapses &nbsp; (numeric or named) to an ordinary space, not U+00A0', () => {
    expect(decodeHtmlEntities('&#160;')).toBe(' ')
    expect(decodeHtmlEntities('&nbsp;').charCodeAt(0)).toBe(32)
  })

  it('leaves a bare "&" with no matching entity syntax alone', () => {
    expect(decodeHtmlEntities('Sales & Marketing')).toBe('Sales & Marketing')
  })
})
