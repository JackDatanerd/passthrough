import { describe, it, expect } from 'vitest'
import { extractJson, detectFabrication, sanitizeGeneratedHtml, isAllowedResourceUrl } from '../src/services/claude.service.js'

describe('extractJson', () => {
  it('parses a plain, unfenced JSON response (the normal case)', () => {
    expect(extractJson('{"aiScore": 82}')).toEqual({ aiScore: 82 })
  })

  it('parses a plain JSON response whose content contains a literal triple-backtick sequence', () => {
    // AUDIT BUG: the old lazy-match fence regex ran unconditionally and
    // mistook this embedded ``` pair for a wrapper fence, truncating the
    // string it handed to JSON.parse and discarding an entirely valid
    // response. Realistic for a technical/DevRel resume bullet.
    const payload = {
      resume: {
        experience: [{
          company: 'Acme', title: 'DevRel Engineer', dates: '2020-2024',
          bullets: ['Authored README examples such as ```curl -X POST /api/v1/scan``` used by partners']
        }]
      },
      quantificationOpportunities: []
    }
    expect(extractJson(JSON.stringify(payload))).toEqual(payload)
  })

  it('strips a genuine markdown code fence wrapper', () => {
    const body = '```json\n' + JSON.stringify({ aiScore: 91, missingKeywords: ['Kubernetes'] }) + '\n```'
    expect(extractJson(body)).toEqual({ aiScore: 91, missingKeywords: ['Kubernetes'] })
  })

  it('strips a fence wrapper even when the JSON payload inside it also contains a triple-backtick', () => {
    // Greedy match to the LAST ``` in the response, not the first — this is
    // the "doubly nested" case: a real wrapper fence AND an embedded one.
    const payload = { bullets: ['Used ```git rebase``` heavily'] }
    const body = '```json\n' + JSON.stringify(payload) + '\n```'
    expect(extractJson(body)).toEqual(payload)
  })

  it('tolerates a preamble sentence before a fenced response', () => {
    const body = 'Sure, here you go:\n```json\n' + JSON.stringify({ ok: true }) + '\n```'
    expect(extractJson(body)).toEqual({ ok: true })
  })

  it('throws on genuinely malformed content', () => {
    expect(() => extractJson('not json at all')).toThrow()
  })

  it('throws on non-string input', () => {
    expect(() => extractJson(null)).toThrow('Claude response was not a string')
  })
})

describe('detectFabrication', () => {
  const orig = {
    experience: [{ company: 'Acme Corp' }],
    education: [{ institution: 'Cape Town University' }],
    projects: [{ name: 'Internal Tools' }]
  }

  it('does not flag an unchanged rewrite', () => {
    expect(detectFabrication(orig, orig)).toBe(false)
  })

  it('does not flag corporate-suffix normalization (Acme Corp -> Acme)', () => {
    const rewritten = { experience: [{ company: 'Acme' }], education: [], projects: [] }
    expect(detectFabrication(orig, rewritten)).toBe(false)
  })

  it('does not flag a legitimate shortening of a real institution name', () => {
    const rewritten = { experience: [], education: [{ institution: 'Cape Town' }], projects: [] }
    expect(detectFabrication(orig, rewritten)).toBe(false)
  })

  it('flags a wholly invented company', () => {
    const rewritten = { experience: [{ company: 'Globodyne' }], education: [], projects: [] }
    expect(detectFabrication(orig, rewritten)).toBe(true)
  })

  it('flags a rewrite that drops a real employer entirely', () => {
    const rewritten = { experience: [], education: [], projects: [] }
    // Nothing new was added, so nothing to flag under the "new name not
    // found in original" rule — dropping isn't this function's job (a
    // separate concern), but confirms an empty rewrite never false-positives.
    expect(detectFabrication(orig, rewritten)).toBe(false)
  })

  it('BUG FIX: flags a real company name padded with invented detail', () => {
    // The old code accepted this because n.includes(o) was also checked —
    // "IBM" is contained in the fabricated "IBM Watson Research", so the
    // old bidirectional check treated an invented expansion as legitimate.
    const withIbm = { experience: [{ company: 'IBM' }], education: [], projects: [] }
    const padded  = { experience: [{ company: 'IBM Watson Research' }], education: [], projects: [] }
    expect(detectFabrication(withIbm, padded)).toBe(true)
  })
})

describe('isAllowedResourceUrl', () => {
  it('allows the Google Fonts hosts', () => {
    expect(isAllowedResourceUrl('https://fonts.googleapis.com/css?family=Foo')).toBe(true)
    expect(isAllowedResourceUrl('https://fonts.gstatic.com/s/foo.woff2')).toBe(true)
  })

  it('rejects a disallowed host', () => {
    expect(isAllowedResourceUrl('https://evil.com/x')).toBe(false)
  })

  it('rejects lookalike hosts (prefix/suffix tricks)', () => {
    expect(isAllowedResourceUrl('https://fonts.googleapis.com.evil.com/x')).toBe(false)
    expect(isAllowedResourceUrl('https://evil.com/fonts.googleapis.com')).toBe(false)
  })

  it('rejects a non-http(s) scheme', () => {
    expect(isAllowedResourceUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('sanitizeGeneratedHtml', () => {
  it('leaves ordinary safe markup untouched', () => {
    const html = '<div style="color:red"><p>Hello World</p></div>'
    expect(sanitizeGeneratedHtml(html)).toBe(html)
  })

  it('strips script tags, including an unclosed one', () => {
    expect(sanitizeGeneratedHtml('<p>hi</p><script>alert(1)</script>')).toBe('<p>hi</p>')
    // BUG FIX: a script tag with no closing tag (truncated generation, or a
    // deliberate injection) previously survived entirely.
    expect(sanitizeGeneratedHtml('<p>hi</p><script src="http://evil.com/x.js">'))
      .toBe('<p>hi</p>')
  })

  it('strips on* event handlers, including the slash-separated bypass shape', () => {
    expect(sanitizeGeneratedHtml('<div onclick="fetch(1)">x</div>')).toBe('<div>x</div>')
    // BUG FIX: `<div/onclick=...>` (slash instead of whitespace before the
    // attribute) is valid, browser-tolerated HTML that the old \s-only
    // boundary missed.
    expect(sanitizeGeneratedHtml('<div/onclick="fetch(1)">x</div>')).toBe('<div>x</div>')
  })

  it('neutralizes javascript:/data: URIs, including with leading whitespace', () => {
    expect(sanitizeGeneratedHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a href="#">x</a>')
    // BUG FIX: browsers strip leading whitespace when resolving a URL
    // scheme, so `href=" javascript:..."` still executes despite not
    // matching the old quote-then-scheme regex.
    expect(sanitizeGeneratedHtml('<a href=" javascript:alert(1)">x</a>')).toBe('<a href="#">x</a>')
  })

  it('strips resource-loading tags entirely', () => {
    expect(sanitizeGeneratedHtml('<img src="http://169.254.169.254/">')).toBe('')
    expect(sanitizeGeneratedHtml('<iframe src="http://evil.com"></iframe>')).toBe('')
  })

  it('keeps an allowlisted Google Fonts <link>, quoted or unquoted', () => {
    const quoted = '<link href="https://fonts.googleapis.com/css?family=Foo" rel="stylesheet">'
    expect(sanitizeGeneratedHtml(quoted)).toBe(quoted)
    // BUG FIX: an unquoted href (valid HTML) used to have no match at all
    // and got the whole tag stripped, silently breaking the requested font.
    const unquoted = '<link href=https://fonts.googleapis.com/css?family=Foo rel=stylesheet>'
    expect(sanitizeGeneratedHtml(unquoted)).toBe(unquoted)
  })

  it('strips a <link> pointing at a disallowed host, quoted or unquoted', () => {
    expect(sanitizeGeneratedHtml('<link href="https://evil.com/x" rel="stylesheet">')).toBe('')
    expect(sanitizeGeneratedHtml('<link href=https://evil.com/x rel=stylesheet>')).toBe('')
  })

  it('neutralizes a disallowed CSS url() but keeps an allowlisted one', () => {
    expect(sanitizeGeneratedHtml('div{background:url(http://evil.com/x)}')).toBe('div{background:url()}')
    const ok = 'div{font-family:url(https://fonts.gstatic.com/s/foo.woff2)}'
    expect(sanitizeGeneratedHtml(ok)).toBe(ok)
  })
})
