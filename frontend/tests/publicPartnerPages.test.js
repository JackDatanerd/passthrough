import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { publicPages } from '../src/lib/publicPages.js'
import { sitemapXml } from '../seo/render.js'

// Section 4 round 6 (bug): robots.txt said `Disallow: /partner/`, which also blocked /partner/apply — the one public
// page of the program, which _headers deliberately makes indexable — and pointed at a sitemap that did not exist.
// The sitemap is no longer a hand-kept file: the build generates it from src/lib/publicPages.js (frontend/seo/), so this
// checks what the build will publish.
const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')
const robots = pub('robots.txt')
const headers = pub('_headers')
const sitemap = sitemapXml(publicPages())
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8')

const disallowed = robots.split(/\r?\n/).filter(l => /^Disallow:/i.test(l)).map(l => l.replace(/^Disallow:\s*/i, '').trim())
const blockedByRobots = p => disallowed.some(d => d && p.startsWith(d))

describe('robots.txt', () => {
  it('does not block the public partner pages', () => {
    expect(blockedByRobots('/partner/apply')).toBe(false)
    expect(blockedByRobots('/partner/terms')).toBe(false)
  })
  it('still keeps the token pages and the API out', () => {
    expect(blockedByRobots('/partner/dashboard')).toBe(true)
    expect(blockedByRobots('/partner/payout-details')).toBe(true)
    expect(blockedByRobots('/api/anything')).toBe(true)
    expect(blockedByRobots('/dashboard/settings')).toBe(true)
  })
  it('points at the sitemap that now exists', () => {
    expect(robots).toMatch(/^Sitemap:\s*https:\/\/usepassthrough\.com\/sitemap\.xml/m)
  })
})

describe('sitemap.xml', () => {
  const urls = [...sitemap.matchAll(/<loc>https:\/\/usepassthrough\.com(\/[^<]*)<\/loc>/g)].map(m => m[1])
  it('is a urlset with entries', () => {
    expect(sitemap).toMatch(/<urlset[^>]+sitemaps\.org/)
    expect(urls.length).toBeGreaterThan(3)
  })
  it('lists only routes that exist, none robots.txt blocks, and no token pages', () => {
    for (const u of urls) {
      expect(blockedByRobots(u), `${u} is blocked by robots.txt`).toBe(false)
      expect(app.includes(`path="${u}"`), `${u} has no route in App.jsx`).toBe(true)
    }
    expect(urls).not.toContain('/partner/dashboard')
    expect(urls).not.toContain('/partner/payout-details')
  })
  it('includes both public partner pages', () => {
    expect(urls).toEqual(expect.arrayContaining(['/partner/apply', '/partner/terms']))
  })
})

describe('_headers', () => {
  const block = path => headers.split(/\r?\n\r?\n/).find(b => new RegExp(`^\\s*${path}\\s*$`, 'm').test(b)) || ''
  it.each(['/partner/apply', '/partner/terms'])('%s detaches the token-page headers so it can be indexed and cached', p => {
    const b = block(p)
    expect(b).toMatch(/^\s*!\s*X-Robots-Tag/m)
    expect(b).toMatch(/^\s*!\s*Cache-Control/m)
    expect(b).toMatch(/^\s*!\s*Referrer-Policy/m)
  })
})
