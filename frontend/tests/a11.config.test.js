import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { onRequestGet } from '../functions/v/[code].js'
import { isPrivatePath, titleFor, DEFAULT_TITLE } from '../src/lib/pageTitles'

// A11: the expert site's and the customer site's deploy files, and the routes that are private. Cloudflare Pages joins same-named headers from every
// rule a path matches (that is why public/_headers already uses `!`), so these read the files the way Pages does.
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
function parse(text) {
  const rules = []; let cur = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (!/^\s/.test(raw)) { cur = { pattern: raw.trim(), lines: [] }; rules.push(cur) } else if (cur) cur.lines.push(raw.trim())
  }
  return rules
}
const matches = (pattern, path) => pattern.includes('*') ? new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(path) : pattern === path
// the headers Pages would send: values of the same name are joined, `! Name` first removes what earlier rules gave
function sent(rules, path) {
  const out = {}
  for (const r of rules.filter(x => matches(x.pattern, path))) for (const l of r.lines) {
    if (l.startsWith('!')) { delete out[l.slice(1).trim().toLowerCase()]; continue }
    const i = l.indexOf(':'); const k = l.slice(0, i).trim().toLowerCase(); const v = l.slice(i + 1).trim()
    out[k] = out[k] ? `${out[k]}, ${v}` : v
  }
  return out
}

describe('expert site headers (public-experts/_headers)', () => {
  const rules = parse(read('../public-experts/_headers'))
  it('the page and every route are never cached and never indexed', () => {
    for (const p of ['/', '/desk', '/admin/jobs/abc']) { const h = sent(rules, p); expect(h['cache-control'], p).toBe('no-store'); expect(h['x-robots-tag']).toMatch(/noindex/) }
  })
  it('B8 the built files are cached for a year and ONLY that: no-store is not joined onto them', () => {
    const h = sent(rules, '/assets/experts-abc123.js'); expect(h['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(h['content-security-policy']).toMatch(/default-src 'self'/); expect(h['x-frame-options']).toBe('DENY')      // everything else still applies
  })
})

describe('expert site redirects and build (public-experts/_redirects, vite.experts.config.js)', () => {
  it('B14 the fallback is the documented single-page one, and the build writes exactly that file', () => {
    expect(read('../public-experts/_redirects').trim()).toBe('/* /index.html 200')
    const cfg = read('../vite.experts.config.js'); expect(cfg).toMatch(/experts\.html/); expect(cfg).toMatch(/dist-experts\/index\.html/); expect(cfg).toMatch(/renameSync/)
  })
  it('B12 the dev proxy states the Origin the API checks, as well as the Host', () => {
    expect(read('../vite.experts.config.js')).toMatch(/headers:\s*\{\s*host:\s*'experts\.localhost',\s*origin:\s*'http:\/\/experts\.localhost'\s*\}/)
  })
})

describe('customer site: the human and expert pages are private', () => {
  const rules = parse(read('../public/_headers'))
  it('B7 headers: not indexed, not cached, no referrer', () => {
    for (const p of ['/human', '/human/order', '/human/orders', '/expert', '/expert/jobs']) {
      const h = sent(rules, p); expect(h['x-robots-tag'], p).toMatch(/noindex/)
      if (p !== '/human' && p !== '/expert') { expect(h['cache-control'], p).toBe('no-store'); expect(h['referrer-policy'], p).toBe('no-referrer') }
    }
    expect(sent(rules, '/assets/index-abc.js')['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(sent(rules, '/pricing')['x-robots-tag']).toBeUndefined()
  })
  it('B7 the app: private (no canonical, noindex meta) and with titles of their own, not the homepage title', () => {
    for (const p of ['/human/order', '/human/orders', '/expert', '/expert/jobs']) { expect(isPrivatePath(p), p).toBe(true); expect(titleFor(p), p).not.toBe(DEFAULT_TITLE) }
    expect(titleFor('/human/orders')).toBe('Your human rewrite orders — Passthrough'); expect(titleFor('/human/order')).toBe('Order a human rewrite — Passthrough'); expect(titleFor('/expert')).toBe('Expert workbench — Passthrough')
    expect(isPrivatePath('/pricing')).toBe(false)
  })
})

describe('/v/:code Function on the expert host', () => {
  it('B13 is a pass-through there: nothing is rewritten and the API is never called, even with API_URL set', async () => {
    const f = vi.fn(); const had = globalThis.fetch; globalThis.fetch = f
    try {
      const page = new Response('<html></html>')
      const res = await onRequestGet({ params: { code: 'AB3XY7K2PQ' }, env: { API_URL: 'https://api.example/api' }, request: { url: 'https://experts.usepassthrough.com/v/AB3XY7K2PQ' }, next: async () => page, waitUntil: () => {} })
      expect(res).toBe(page); expect(f).not.toHaveBeenCalled()
    } finally { globalThis.fetch = had }
  })
})
