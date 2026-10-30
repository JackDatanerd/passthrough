// Pure functions behind the search-indexing build step (no file or network access, so tests can call them directly).
// frontend/seo/vitePlugin.js applies them to the built site; the registry they read is src/lib/publicPages.js.
import { SITE_ORIGIN } from '../src/lib/publicPages.js'

export class SeoError extends Error {}

const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
export const escapeXml = s => String(s).replace(/[&<>"']/g, c => XML_ESC[c])
const ATTR_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
export const escapeAttr = s => String(s).replace(/[&<>"]/g, c => ATTR_ESC[c])

// The home page keeps its trailing slash; every other page is the bare path.
export const absoluteUrl = (path, origin = SITE_ORIGIN) => (path === '/' ? `${origin}/` : `${origin}${path}`)

// The sitemap. `buildId` (the commit being built) is written into a comment: scripts/indexnow.mjs reads it back from the
// LIVE site to know that a given commit has finished deploying before it notifies the search engines.
export function sitemapXml(pages, { origin = SITE_ORIGIN, buildId = '' } = {}) {
  const id = String(buildId || 'dev').replace(/[^A-Za-z0-9._]/g, '_')
  const urls = pages.map(p => {
    const lastmod = p.lastmod ? `<lastmod>${escapeXml(p.lastmod)}</lastmod>` : ''
    return `  <url><loc>${escapeXml(absoluteUrl(p.path, origin))}</loc>${lastmod}</url>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Generated at build time from frontend/src/lib/publicPages.js. Do not edit; add pages there. -->',
    `<!-- build: ${id} -->`,
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n')
}

// What the deployed sitemap says about itself. Returns null when there is no marker (an old sitemap, or an HTML page).
export function parseBuildMarker(xml) {
  const m = /<!--\s*build:\s*([A-Za-z0-9._]+)\s*-->/.exec(String(xml || ''))
  return m ? m[1] : null
}

// '/pricing' -> 'pricing.html', '/partner/apply' -> 'partner/apply.html' (Cloudflare Pages serves /pricing from
// pricing.html and redirects /pricing/ and /pricing.html to it). The home page is index.html itself: null.
export function outputPathFor(pagePath) {
  if (pagePath === '/') return null
  return `${pagePath.slice(1)}.html`
}

// Each of these must match the shell exactly once, otherwise the shell changed under us and we say so rather than
// shipping a page that quietly kept the homepage's tags.
const META = (attr, name) => new RegExp(`<meta\\s+${attr}="${name}"\\s+content="[^"]*"\\s*/?>`, 'g')
const TITLE = /<title>[^<]*<\/title>/g

function replaceOnce(html, re, replacement, label) {
  const hits = html.match(re)
  if (!hits || hits.length !== 1) throw new SeoError(`index.html: expected exactly one ${label}, found ${hits ? hits.length : 0}`)
  return html.replace(re, () => replacement)
}

// The built index.html with this page's own <head>: title, description, canonical, Open Graph and Twitter text.
// Images, icons, the manifest, the scripts and the body are untouched, so the SPA boots exactly as it does from index.html.
export function renderPageHtml(shell, page, { origin = SITE_ORIGIN } = {}) {
  const url = absoluteUrl(page.path, origin)
  const t = escapeAttr(page.title)
  const d = escapeAttr(page.description)
  if (/rel=["']canonical["']/i.test(shell)) {
    throw new SeoError('index.html has a static canonical link; it is shared by every route, so canonicals are set per page')
  }
  let html = shell
  html = replaceOnce(html, TITLE, `<title>${escapeAttr(page.title).replace(/&quot;/g, '"')}</title>`, '<title>')
  html = replaceOnce(html, META('name', 'description'), `<meta name="description" content="${d}" />`, 'meta description')
  html = replaceOnce(html, META('property', 'og:url'), `<meta property="og:url" content="${escapeAttr(url)}" />`, 'og:url')
  html = replaceOnce(html, META('property', 'og:title'), `<meta property="og:title" content="${t}" />`, 'og:title')
  html = replaceOnce(html, META('property', 'og:description'), `<meta property="og:description" content="${d}" />`, 'og:description')
  html = replaceOnce(html, META('name', 'twitter:title'), `<meta name="twitter:title" content="${t}" />`, 'twitter:title')
  html = replaceOnce(html, META('name', 'twitter:description'), `<meta name="twitter:description" content="${d}" />`, 'twitter:description')
  return replaceOnce(html, /<\/head>/g, `  <link rel="canonical" href="${escapeAttr(url)}" />\n</head>`, '</head>')
}
