import { describe, it, expect } from 'vitest'
import { buildBadgeEmbeds } from '../src/lib/badgeEmbed'

describe('buildBadgeEmbeds (round 6: PNG + HTML for e-mail signatures)', () => {
  const e = buildBadgeEmbeds('https://api.passthrough.dev/api/', 'AB3XY7K2PQ', 'https://passthrough.dev/v/AB3XY7K2PQ')
  it('keeps the SVG for Markdown and adds a PNG sibling at the same path', () => {
    expect(e.image).toBe('https://api.passthrough.dev/api/verify/AB3XY7K2PQ/badge.svg')
    expect(e.png).toBe('https://api.passthrough.dev/api/verify/AB3XY7K2PQ/badge.png')
    expect(e.markdown).toBe('[![Passthrough badge](https://api.passthrough.dev/api/verify/AB3XY7K2PQ/badge.svg)](https://passthrough.dev/v/AB3XY7K2PQ)')
  })
  it('the HTML snippet links the live page and uses the PNG, at the badge height, with no border', () => {
    expect(e.html).toBe('<a href="https://passthrough.dev/v/AB3XY7K2PQ"><img src="https://api.passthrough.dev/api/verify/AB3XY7K2PQ/badge.png" alt="Passthrough badge" height="20" style="border:0"></a>')
    expect(e.html).not.toContain('.svg')
  })
  it('escapes what it interpolates into attributes', () => {
    const x = buildBadgeEmbeds('https://a.test', 'A', 'https://x.test/v/A?a=1&b="2"')
    expect(x.html).toContain('href="https://x.test/v/A?a=1&amp;b=&quot;2&quot;"')
  })
})
