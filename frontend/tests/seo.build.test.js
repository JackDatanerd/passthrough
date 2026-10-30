import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publicPages, SITE_ORIGIN } from '../src/lib/publicPages.js'
import { sitemapXml, parseBuildMarker, outputPathFor, renderPageHtml, absoluteUrl, SeoError } from '../seo/render.js'
import { changedPages, sourceTouched, indexNowPayload, submitIndexNow, waitForDeploy, INDEXNOW_KEY } from '../seo/indexnow.js'
import seoPlugin from '../seo/vitePlugin.js'

const shell = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
const page = { path: '/pricing', title: 'Pricing — Passthrough', description: 'Scan free. Pay once.' }

describe('sitemapXml', () => {
  const xml = sitemapXml(publicPages(), { buildId: 'abc123' })
  it('is a sitemaps.org urlset listing every registered page, home with its slash and the rest bare', () => {
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/)
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    expect(locs).toEqual(publicPages().map(p => absoluteUrl(p.path)))
    expect(locs[0]).toBe('https://usepassthrough.com/')
    expect(locs).toContain('https://usepassthrough.com/partner/apply')
  })
  it('writes lastmod only for entries that have one, and nothing Google ignores', () => {
    expect(xml).toMatch(/<loc>https:\/\/usepassthrough\.com\/terms<\/loc><lastmod>2026-10-23<\/lastmod>/)
    expect(xml).not.toMatch(/<loc>https:\/\/usepassthrough\.com\/pricing<\/loc><lastmod>/)
    expect(xml).not.toMatch(/changefreq|priority/)
  })
  it('escapes XML and sanitises the build marker', () => {
    const odd = sitemapXml([{ path: '/a-b', title: 't', description: 'd' }], { origin: 'https://x.test/?a=1&b=2', buildId: 'a--b <x>' })
    expect(odd).toContain('&amp;')
    expect(odd).not.toMatch(/<!-- build: [^>]*--[^>]/)
    expect(odd).toContain('<!-- build: a__b__x_ -->')
  })
  it('the marker round-trips, and an HTML page or old sitemap has none', () => {
    expect(parseBuildMarker(xml)).toBe('abc123')
    expect(parseBuildMarker('<!doctype html><html></html>')).toBeNull()
    expect(parseBuildMarker(null)).toBeNull()
    expect(parseBuildMarker(sitemapXml([]))).toBe('dev')
  })
})

describe('outputPathFor', () => {
  it('maps a page to the file Cloudflare Pages serves it from; the home page is index.html itself', () => {
    expect(outputPathFor('/')).toBeNull()
    expect(outputPathFor('/pricing')).toBe('pricing.html')
    expect(outputPathFor('/partner/apply')).toBe('partner/apply.html')
    expect(outputPathFor('/blog/why-ats-rejects-resumes')).toBe('blog/why-ats-rejects-resumes.html')
  })
})

describe('renderPageHtml', () => {
  it.each(publicPages().filter(p => p.path !== '/').map(p => [p.path, p]))('%s gets its own head and keeps the app', (_p, pg) => {
    const html = renderPageHtml(shell, pg)
    const url = `https://usepassthrough.com${pg.path}`
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).toContain(`<link rel="canonical" href="${url}" />`)
    expect(html.match(/rel="canonical"/g)).toHaveLength(1)
    expect(html).toContain(`<meta property="og:url" content="${url}" />`)
    for (const name of ['description', 'twitter:description']) expect(html).toContain(`<meta name="${name}" content="${pg.description}" />`)
    expect(html).toContain(`<meta property="og:title" content="${pg.title}" />`)
    // untouched: the image cards, icons, manifest, structured data, the mount point and the boot script
    for (const keep of ['og:image', 'twitter:image', 'rel="manifest"', 'application/ld+json', '<div id="root"></div>', 'src="/src/main.jsx"', 'rel="apple-touch-icon"']) {
      expect(html, keep).toContain(keep)
    }
    // and nothing of the homepage's own copy is left in the tags it replaced
    expect(html).not.toContain('Does your resume pass the ATS filter?</title>')
    expect(html).not.toContain('content="Free ATS scan in 30 seconds. No account needed."')
  })

  it('escapes quotes, ampersands and angle brackets, and does not treat "$&" in copy as a replacement pattern', () => {
    const html = renderPageHtml(shell, { path: '/x', title: 'Q&A "ATS" <b> $& $1', description: 'a "b" & <c> $`' })
    expect(html).toContain('<title>Q&amp;A "ATS" &lt;b&gt; $&amp; $1</title>')   // "$&amp;": the "&" is escaped, and "$&" was not expanded to the matched text
    expect(html).toContain('content="a &quot;b&quot; &amp; &lt;c&gt; $`"')
    expect(html).not.toContain('<b>')
  })

  it('refuses a shell that has changed shape instead of shipping the homepage tags under another URL', () => {
    expect(() => renderPageHtml(shell.replace(/<meta property="og:url"[^>]*>/, ''), page)).toThrow(SeoError)
    expect(() => renderPageHtml(shell.replace('<title>', '<title>x</title><title>'), page)).toThrow(/<title>/)
    expect(() => renderPageHtml(shell.replace('</head>', '<link rel="canonical" href="https://usepassthrough.com/" /></head>'), page)).toThrow(/canonical/)
    expect(() => renderPageHtml('<html><body></body></html>', page)).toThrow(SeoError)
  })
})

describe('vite plugin', () => {
  function run(files, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-'))
    for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
    const plugin = seoPlugin()
    const warn = vi.fn()
    const saved = { ...process.env }
    Object.assign(process.env, env)
    try {
      plugin.configResolved({ root: dir, build: { outDir: '.' } })
      plugin.closeBundle.call({ warn })
    } finally { process.env = saved }
    return { dir, warn }
  }

  it('writes the sitemap (stamped with the Cloudflare commit) and a head-specific copy per page', () => {
    const { dir, warn } = run({ 'index.html': shell }, { CF_PAGES_COMMIT_SHA: 'deadbeef' })
    expect(warn).not.toHaveBeenCalled()
    expect(parseBuildMarker(fs.readFileSync(path.join(dir, 'sitemap.xml'), 'utf8'))).toBe('deadbeef')
    for (const p of publicPages().filter(p => p.path !== '/')) {
      expect(fs.readFileSync(path.join(dir, `${p.path.slice(1)}.html`), 'utf8')).toContain(`<link rel="canonical" href="https://usepassthrough.com${p.path}" />`)
    }
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(shell)   // the shell itself is never modified
  })

  it('a page whose head cannot be written is a warning, not a failed deploy; the sitemap still ships', () => {
    const { dir, warn } = run({ 'index.html': shell, 'pricing.html': 'already here' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/\/pricing/)
    expect(fs.readFileSync(path.join(dir, 'pricing.html'), 'utf8')).toBe('already here')
    expect(fs.existsSync(path.join(dir, 'sitemap.xml'))).toBe(true)
  })

  it('does nothing when the build produced no index.html', () => {
    const { dir } = run({ 'other.txt': 'x' })
    expect(fs.existsSync(path.join(dir, 'sitemap.xml'))).toBe(false)
  })
})

describe('IndexNow: which pages to announce', () => {
  const a = { path: '/a', title: 'A', description: 'da', source: ['src/a.jsx'] }
  const b = { path: '/b', title: 'B', description: 'db', source: ['src/shared/'] }
  const paths = r => r.map(p => p.path)

  it('announces new pages, and nothing when nothing changed', () => {
    expect(paths(changedPages({ before: [a], after: [a, b], changedFiles: [] }))).toEqual(['/b'])
    expect(changedPages({ before: [a, b], after: [a, b], changedFiles: ['README.md', 'src/other.js'] })).toEqual([])
  })
  it('announces a page whose title, description or lastmod changed', () => {
    expect(paths(changedPages({ before: [a], after: [{ ...a, title: 'A2' }] }))).toEqual(['/a'])
    expect(paths(changedPages({ before: [a], after: [{ ...a, description: 'new' }] }))).toEqual(['/a'])
    expect(paths(changedPages({ before: [a], after: [{ ...a, lastmod: '2026-10-30' }] }))).toEqual(['/a'])
  })
  it('announces a page whose source files changed, by exact file or by folder', () => {
    expect(paths(changedPages({ before: [a, b], after: [a, b], changedFiles: ['src/a.jsx'] }))).toEqual(['/a'])
    expect(paths(changedPages({ before: [a, b], after: [a, b], changedFiles: ['src/shared/deep/x.js'] }))).toEqual(['/b'])
    expect(sourceTouched(['src/shared/'], ['src/sharedness.js'])).toBe(false)
    expect(sourceTouched(undefined, ['x'])).toBe(false)
  })
  it('a first run (no previous state) and --all announce everything', () => {
    expect(paths(changedPages({ before: [], after: [a, b] }))).toEqual(['/a', '/b'])
    expect(paths(changedPages({ before: [a, b], after: [a, b], all: true }))).toEqual(['/a', '/b'])
  })
  it('a removed page is not announced (it is gone from the sitemap, which is how crawlers learn)', () => {
    expect(changedPages({ before: [a, b], after: [a] })).toEqual([])
  })
})

describe('IndexNow: the request', () => {
  const res = (status, text = '') => ({ status, ok: status < 300, text: async () => text })

  it('names the host, the key and where the key file lives', () => {
    expect(indexNowPayload(['https://usepassthrough.com/x'])).toEqual({
      host: 'usepassthrough.com', key: INDEXNOW_KEY, keyLocation: `https://usepassthrough.com/${INDEXNOW_KEY}.txt`, urlList: ['https://usepassthrough.com/x'],
    })
  })
  it('accepts 200 and 202', async () => {
    for (const s of [200, 202]) {
      const f = vi.fn(async () => res(s))
      await submitIndexNow(['https://usepassthrough.com/x'], { fetchImpl: f, sleep: async () => {} })
      expect(f).toHaveBeenCalledTimes(1)
      expect(f.mock.calls[0][0]).toBe('https://api.indexnow.org/indexnow')
      expect(JSON.parse(f.mock.calls[0][1].body).urlList).toEqual(['https://usepassthrough.com/x'])
    }
  })
  it('retries 429 and 5xx with a growing wait, then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200))
    const sleep = vi.fn(async () => {})
    await submitIndexNow(['u'], { fetchImpl: f, sleep })
    expect(f).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(c => c[0])).toEqual([5000, 15000])
  })
  it('gives up after the last attempt, and never retries a real rejection', async () => {
    const stuck = vi.fn(async () => res(503))
    await expect(submitIndexNow(['u'], { fetchImpl: stuck, sleep: async () => {}, attempts: 3 })).rejects.toThrow(/503/)
    expect(stuck).toHaveBeenCalledTimes(3)
    const forbidden = vi.fn(async () => res(403, 'key not found'))
    await expect(submitIndexNow(['u'], { fetchImpl: forbidden, sleep: async () => {} })).rejects.toThrow(/403: key not found/)
    expect(forbidden).toHaveBeenCalledTimes(1)
  })
  it('splits more than 10,000 URLs into several requests', async () => {
    const f = vi.fn(async () => res(200))
    await submitIndexNow(Array.from({ length: 10001 }, (_, i) => `https://usepassthrough.com/p${i}`), { fetchImpl: f })
    expect(f).toHaveBeenCalledTimes(2)
    expect(JSON.parse(f.mock.calls[0][1].body).urlList).toHaveLength(10000)
    expect(JSON.parse(f.mock.calls[1][1].body).urlList).toHaveLength(1)
  })
})

describe('IndexNow: waiting for the deploy', () => {
  const body = id => ({ ok: true, text: async () => sitemapXml([], { buildId: id }) })
  function clock() { let t = 0; return { now: () => t, sleep: async ms => { t += ms } } }

  it('returns once the live sitemap carries this commit', async () => {
    const c = clock()
    const f = vi.fn().mockResolvedValueOnce(body('old')).mockResolvedValueOnce(body('old')).mockResolvedValueOnce(body('mine'))
    expect(await waitForDeploy({ sha: 'mine', fetchImpl: f, ...c })).toBe(true)
    expect(f).toHaveBeenCalledTimes(3)
  })
  it('also accepts a later commit that contains this one (a newer push superseded it)', async () => {
    const c = clock()
    const f = vi.fn(async () => body('newer'))
    expect(await waitForDeploy({ sha: 'mine', isAncestor: (a, b) => a === 'mine' && b === 'newer', fetchImpl: f, ...c })).toBe(true)
  })
  it('keeps waiting through errors and HTML answers, and gives up at the deadline', async () => {
    const c = clock()
    const f = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ ok: false, text: async () => '' })
      .mockResolvedValue({ ok: true, text: async () => '<!doctype html>' })
    expect(await waitForDeploy({ sha: 'mine', fetchImpl: f, ...c, timeoutMs: 100000, intervalMs: 20000 })).toBe(false)
    expect(c.now()).toBeLessThanOrEqual(100000)
    expect(f.mock.calls.length).toBeGreaterThan(3)
  })
  it('asks for a fresh copy each time', async () => {
    const f = vi.fn(async () => body('mine'))
    await waitForDeploy({ sha: 'mine', fetchImpl: f, ...clock() })
    expect(f.mock.calls[0][0]).toMatch(new RegExp(`^${SITE_ORIGIN}/sitemap\\.xml\\?indexnow=\\d+$`))
  })
})
