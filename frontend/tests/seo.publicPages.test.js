import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  publicPages, validatePublicPages, findPublicPage, normalizePath, canonicalOriginFor,
  SITE_ORIGIN, HOME_TITLE, HOME_DESCRIPTION,
} from '../src/lib/publicPages.js'
import { titleFor, isPrivatePath } from '../src/lib/pageTitles.js'
import { INDEXNOW_KEY } from '../seo/indexnow.js'

// The search-index registry (src/lib/publicPages.js) feeds the sitemap, every page's <head> and IndexNow. These tests are
// its guard rails: a page that is listed but would be noindexed, a route that is public but unlisted, a registry that
// drifted from the page it describes, or a typo that would ship a broken sitemap, all fail HERE, in CI.
const frontend = path.join(__dirname, '..')
const repo = path.join(frontend, '..')
const read = (...p) => fs.readFileSync(path.join(frontend, ...p), 'utf8')
const pages = publicPages()

describe('registry shape', () => {
  it('is structurally valid', () => expect(validatePublicPages(pages)).toEqual([]))

  it('catches the mistakes that would ship a broken sitemap', () => {
    const ok = { path: '/x', title: 't', description: 'd' }
    const bad = (e) => validatePublicPages([ok, ...e])
    expect(bad([{ ...ok }]).join()).toMatch(/duplicate/)
    expect(bad([{ ...ok, path: '/y/' }]).join()).toMatch(/trailing slash/)
    expect(bad([{ ...ok, path: '/Y' }]).join()).toMatch(/lower-case/)
    expect(bad([{ ...ok, path: '/y.html' }]).join()).toMatch(/extension/)
    expect(bad([{ ...ok, path: '/y?a=1' }]).join()).toMatch(/query/)
    expect(bad([{ ...ok, path: 'y' }]).join()).toMatch(/starting with "\/"/)
    expect(bad([{ ...ok, path: '/y', title: ' ' }]).join()).toMatch(/title/)
    expect(bad([{ ...ok, path: '/y', description: '' }]).join()).toMatch(/description/)
    expect(bad([{ ...ok, path: '/y', lastmod: '2026-13-45' }]).join()).toMatch(/lastmod/)
    expect(bad([{ ...ok, path: '/y', lastmod: 'yesterday' }]).join()).toMatch(/lastmod/)
    expect(bad([{ ...ok, path: '/y', source: 'file.js' }]).join()).toMatch(/source/)
    expect(validatePublicPages([ok, { ...ok, path: '/blog/some-post_2', lastmod: '2026-10-30', source: ['a/b.md'] }])).toEqual([])
  })

  it('has titles and descriptions the search engines will show whole', () => {
    for (const p of pages) {
      expect(p.title.length, `${p.path} title`).toBeLessThanOrEqual(65)
      expect(p.description.length, `${p.path} description`).toBeGreaterThanOrEqual(50)
      expect(p.description.length, `${p.path} description`).toBeLessThanOrEqual(160)
    }
  })

  it('does not put prices or promo dates in descriptions (they go stale in the search result)', () => {
    for (const p of pages) expect(p.description, p.path).not.toMatch(/\$\s?\d|\d\s?%|20\d\d/)
  })

  it('has real source files for every entry (a dead path would silence IndexNow for that page)', () => {
    for (const p of pages) for (const s of p.source || []) {
      expect(fs.existsSync(path.join(repo, s)), `${p.path}: ${s}`).toBe(true)
    }
  })

  it('stays dependency-free: IndexNow loads the previous commit\'s copy of this file on its own', () => {
    expect(read('src', 'lib', 'publicPages.js')).not.toMatch(/^\s*import\s/m)
  })
})

describe('the shared index.html agrees with the registry home entry', () => {
  const html = read('index.html')
  it('title and description', () => {
    expect(html).toContain(`<title>${HOME_TITLE}</title>`)
    expect(html.replace(/\s+/g, ' ')).toContain(`<meta name="description" content="${HOME_DESCRIPTION}" />`)
    expect(findPublicPage('/')).toMatchObject({ title: HOME_TITLE, description: HOME_DESCRIPTION })
  })
  it('has no static canonical (it would claim every route is the homepage)', () => {
    expect(html).not.toMatch(/rel=["']canonical["']/i)
  })
})

describe('what the registry promises, the rest of the site must honour', () => {
  const robots = read('public', 'robots.txt')
  const disallowed = robots.split(/\r?\n/).filter(l => /^Disallow:/i.test(l)).map(l => l.replace(/^Disallow:\s*/i, '').trim()).filter(Boolean)

  // _headers, evaluated the way Cloudflare Pages merges it for a path: matching rules in file order, `! Name` detaches
  // what an earlier rule set. Host rules (https://...) are not about this site's paths.
  function headersFor(p) {
    const out = {}
    let applies = false
    for (const raw of read('public', '_headers').split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith('#')) continue
      if (!/^\s/.test(raw)) {
        const pat = raw.trim()
        applies = !pat.startsWith('http') && new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(p)
        continue
      }
      if (!applies) continue
      const line = raw.trim()
      if (line.startsWith('!')) delete out[line.slice(1).trim().toLowerCase()]
      else { const i = line.indexOf(':'); out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim() }
    }
    return out
  }

  it.each(pages.map(p => p.path))('%s is crawlable, indexable and not private', p => {
    expect(disallowed.some(d => p.startsWith(d)), 'blocked by robots.txt').toBe(false)
    expect(headersFor(p)['x-robots-tag'] || '', 'noindex header').not.toMatch(/noindex/i)
    expect(isPrivatePath(p), 'treated as private by the SPA (it would add <meta robots noindex>)').toBe(false)
  })

  it('the two public partner pages are not private even though /partner/* is (this stamped noindex on them at runtime)', () => {
    expect(isPrivatePath('/partner/apply')).toBe(false)
    expect(isPrivatePath('/partner/terms')).toBe(false)
    expect(isPrivatePath('/partner/dashboard')).toBe(true)
    expect(isPrivatePath('/partner/payout-details')).toBe(true)
  })

  it('the *.pages.dev addresses are kept out of search, the real domain is not touched', () => {
    const h = read('public', '_headers')
    expect(h).toMatch(/^https:\/\/:project\.pages\.dev\/\*\s*\n\s+X-Robots-Tag:\s*noindex/m)
    expect(h).toMatch(/^https:\/\/:version\.:project\.pages\.dev\/\*\s*\n\s+X-Robots-Tag:\s*noindex/m)
  })

  it('robots.txt points at the generated sitemap', () => {
    expect(robots).toMatch(new RegExp(`^Sitemap:\\s*${SITE_ORIGIN.replace(/[.]/g, '\\.')}/sitemap\\.xml\\s*$`, 'm'))
  })
})

describe('every public route is either in the registry or deliberately not', () => {
  const app = read('src', 'App.jsx')
  const routes = [...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map(m => m[1])
  const toRegex = r => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+').replace(/\*/g, '.*')}/?$`, 'i')

  // Reachable without signing in but meant for nobody's search results: sign-in and account-recovery forms, and pages
  // opened from an emailed or in-app link that carries a token. (/employer/* also has noindex in _headers.)
  const NOT_INDEXED_EXACT = ['/login', '/register', '/forgot-password', '/confirm-email-change']
  const NOT_INDEXED_PREFIX = ['/employer/', '/human/', '/expert/']

  it('every registry path is a real route (the sitemap must never list a page that is not there)', () => {
    for (const p of pages) {
      expect(routes.some(r => r !== '*' && toRegex(r).test(p.path)), `${p.path} has no <Route> in App.jsx`).toBe(true)
    }
  })

  it('a new public route must be added to lib/publicPages.js (or to the not-indexed list here, on purpose)', () => {
    const listed = new Set(pages.map(p => p.path))
    const unlisted = routes
      .filter(r => !/[:*]/.test(r))
      .filter(r => !isPrivatePath(r) && !listed.has(r))
      .filter(r => !NOT_INDEXED_EXACT.includes(r) && !NOT_INDEXED_PREFIX.some(x => r.startsWith(x)))
    expect(unlisted, `public routes missing from frontend/src/lib/publicPages.js: ${unlisted.join(', ')}`).toEqual([])
  })
})

describe('lastmod is only given where it is true', () => {
  const stamp = (file) => {
    const m = /const LAST_UPDATED = '([A-Za-z]+) (\d{1,2}), (\d{4})'/.exec(read('src', 'pages', file))
    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(m[1]) + 1
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  }
  it('/terms and /privacy carry the date printed on the page', () => {
    expect(findPublicPage('/terms').lastmod).toBe(stamp('Terms.jsx'))
    expect(findPublicPage('/privacy').lastmod).toBe(stamp('Privacy.jsx'))
  })
  it('no other page invents one', () => {
    for (const p of pages.filter(p => p.lastmod)) expect(['/terms', '/privacy', ...pages.filter(x => x.path.startsWith('/blog/')).map(x => x.path)]).toContain(p.path)
  })
})

describe('titles', () => {
  it('the tab title is the registry title, so a crawler reads the same string before and after JavaScript', () => {
    for (const p of pages) expect(titleFor(p.path), p.path).toBe(p.title)
    expect(titleFor('/Pricing/')).toBe(findPublicPage('/pricing').title)
  })
  it('pages outside the registry keep their old titles', () => {
    expect(titleFor('/dashboard/settings')).toBe('Settings — Passthrough')
    expect(titleFor('/partner/dashboard')).toBe('Partner — Passthrough')
    expect(titleFor('/nonsense')).toBe(HOME_TITLE)
  })
})

describe('normalizePath / canonicalOriginFor', () => {
  it('normalises case, trailing slashes, query and hash', () => {
    expect(normalizePath('/Pricing/?ref=x#top')).toBe('/pricing')
    expect(normalizePath('')).toBe('/')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('/?mode=manual')).toBe('/')
  })
  it('the real site, www and every pages.dev address canonicalise to the real site; local dev keeps its own origin', () => {
    for (const h of ['usepassthrough.com', 'www.usepassthrough.com', 'WWW.UsePassthrough.com', 'passthrough.pages.dev', 'abc123.passthrough.pages.dev']) {
      expect(canonicalOriginFor(h, `https://${h}`), h).toBe(SITE_ORIGIN)
    }
    expect(canonicalOriginFor('localhost', 'http://localhost:3000')).toBe('http://localhost:3000')
    expect(canonicalOriginFor('evilusepassthrough.com', 'https://evilusepassthrough.com')).toBe('https://evilusepassthrough.com')
  })
})

describe('IndexNow key file', () => {
  it('is published at /<key>.txt and contains exactly the key', () => {
    expect(INDEXNOW_KEY).toMatch(/^[A-Za-z0-9-]{8,128}$/)
    expect(read('public', `${INDEXNOW_KEY}.txt`)).toBe(INDEXNOW_KEY)
  })
})
