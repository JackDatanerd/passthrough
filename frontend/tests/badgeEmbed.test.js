import { describe, it, expect } from 'vitest'
import { buildBadgeEmbeds } from '../src/lib/badgeEmbed'

describe('buildBadgeEmbeds (round 6: PNG + HTML for e-mail signatures)', () => {
  const e = buildBadgeEmbeds('https://api.usepassthrough.com/api/', 'AB3XY7K2PQ', 'https://usepassthrough.com/v/AB3XY7K2PQ')
  it('keeps the SVG for Markdown and adds a PNG sibling at the same path', () => {
    expect(e.image).toBe('https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/badge.svg')
    expect(e.png).toBe('https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/badge.png')
    expect(e.markdown).toBe('[![Passthrough badge](https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/badge.svg)](https://usepassthrough.com/v/AB3XY7K2PQ)')
  })
  it('the HTML snippet links the live page and uses the PNG, at the badge height, with no border', () => {
    expect(e.html).toBe('<a href="https://usepassthrough.com/v/AB3XY7K2PQ"><img src="https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/badge.png" alt="Passthrough badge" height="20" style="border:0"></a>')
    expect(e.html).not.toContain('.svg')
  })
  it('escapes what it interpolates into attributes', () => {
    const x = buildBadgeEmbeds('https://a.test', 'A', 'https://x.test/v/A?a=1&b="2"')
    expect(x.html).toContain('href="https://x.test/v/A?a=1&amp;b=&quot;2&quot;"')
  })
})

describe('buildBadgeEmbeds (round 9: QR code for a printed resume)', () => {
  const e = buildBadgeEmbeds('https://api.usepassthrough.com/api/', 'AB3XY7K2PQ', 'https://usepassthrough.com/v/AB3XY7K2PQ')
  it('names the QR images next to the badge, as SVG and PNG', () => {
    expect(e.qrSvg).toBe('https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/qr.svg')
    expect(e.qrPng).toBe('https://api.usepassthrough.com/api/verify/AB3XY7K2PQ/qr.png')
  })
})
