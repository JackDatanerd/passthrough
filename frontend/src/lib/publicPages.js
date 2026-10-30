// THE list of pages that belong in a search index. Everything search-related reads it:
//
//   * the sitemap          (frontend/seo/render.js, emitted at build time by frontend/seo/vitePlugin.js)
//   * each page's own <head> (title, description, canonical, share tags: the SPA ships one index.html for every route,
//                             so without this every public page told a crawler it was the homepage until its
//                             JavaScript ran; vitePlugin.js writes a copy of the built index.html per entry)
//   * the browser tab title  (lib/pageTitles.js, so the title a crawler reads equals the title the page then sets)
//   * IndexNow               (scripts/indexnow.mjs, run by .github/workflows/indexnow.yml after each deploy: tells Bing,
//                             Yandex, Seznam, Naver and Yep about new or changed entries without anyone resubmitting)
//
// TO ADD A MARKETING PAGE OR A BLOG POST: add ONE object to PAGES / POSTS below, in the same commit as its <Route>.
// Nothing else: the next deploy publishes it in the sitemap, gives it its own <head>, and pings IndexNow. Google
// re-reads the sitemap on its own, so there is nothing to resubmit anywhere. frontend/tests/seo.publicPages.test.js
// fails if a public route exists that is neither listed here nor deliberately unlisted, so a new page cannot be
// forgotten.
//
// Entry shape:
//   path         '/pricing', '/blog/why-ats-rejects-resumes'. No trailing slash, lower-case, no query, no ".html".
//   title        the <title>, also the tab title. Keep it under ~60 characters.
//   description  the meta description / share-card text, 50 to 160 characters. Describe the page; do not put prices
//                or promo dates in it (they change; the search result would go stale).
//   lastmod      optional 'YYYY-MM-DD'. Give it only when you know the page's real last-changed date (a blog post's
//                published/updated date, a legal page's "last updated"). A wrong lastmod teaches Google to ignore the
//                field for the whole site, so the default is to leave it out.
//   source       repo-relative files that make up the page. When one of them changes in a push, IndexNow is told the
//                page changed. A trailing "/" means "everything under this folder".
//
// This file is read by the browser bundle AND by Node (the build plugin, the IndexNow script, and the previous commit's
// copy of it, loaded with `git show`), so it must stay dependency-free: no imports, nothing browser-only.

export const SITE_ORIGIN = 'https://usepassthrough.com'

export const HOME_TITLE = 'Passthrough — Does your resume pass the ATS filter?'
export const HOME_DESCRIPTION = 'Find out if your resume will be auto-rejected before a human sees it. Free ATS scan in 30 seconds.'

export const PAGES = [
  {
    path: '/',
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    source: ['frontend/index.html', 'frontend/src/pages/Home.jsx', 'frontend/src/components/home/', 'frontend/src/lib/homeContent.js'],
  },
  {
    path: '/pricing',
    title: 'Pricing — Passthrough',
    description: 'Scan your resume for ATS problems free, always. Pay once only if you want the fix. One-time prices, no subscriptions.',
    source: ['frontend/src/pages/Pricing.jsx'],
  },
  {
    path: '/check',
    title: 'Check a resume — Passthrough',
    description: 'Check a resume marked Passthrough Verified, by file or by verification code. The file is fingerprinted in your browser and never uploaded.',
    source: ['frontend/src/pages/VerifyLookup.jsx'],
  },
  {
    path: '/partner/apply',
    title: 'Become a partner — Passthrough',
    description: 'Apply to the Passthrough partner program: share Passthrough with your audience and earn commission on every sale made through your link.',
    source: ['frontend/src/pages/PartnerApply.jsx', 'frontend/src/lib/partnerTerms.js'],
  },
  {
    path: '/partner/terms',
    title: 'Partner Program Terms — Passthrough',
    description: 'The terms of the Passthrough partner program: applying, how sales are credited to you, refunds and chargebacks, when you are paid, and conduct.',
    source: ['frontend/src/pages/PartnerTerms.jsx', 'frontend/src/lib/partnerTerms.js'],
  },
  {
    path: '/terms',
    title: 'Terms of Service — Passthrough',
    description: 'The terms of service for Passthrough: what the service is, what you pay for, refunds, your content, AI processing and verification links.',
    // Must equal the LAST_UPDATED date printed on the page (a test compares them).
    lastmod: '2026-10-23',
    source: ['frontend/src/pages/Terms.jsx'],
  },
  {
    path: '/privacy',
    title: 'Privacy Policy — Passthrough',
    description: 'The Passthrough privacy policy: what we collect, how we use it, who we share it with, how long we keep it, and your rights.',
    // Must equal the LAST_UPDATED date printed on the page (a test compares them).
    lastmod: '2026-09-22',
    source: ['frontend/src/pages/Privacy.jsx'],
  },
]

// Blog posts (and any other content that arrives as a series). There is no blog yet. When there is, one object per
// post goes here (its lastmod = its published or last-updated date); if posts later live as files, replace this array
// with a function that reads them: everything downstream only consumes the list returned by publicPages().
export const POSTS = []

export function publicPages() {
  return [...PAGES, ...POSTS]
}

// '/Pricing/?ref=x#top' -> '/pricing' (the router is case-insensitive, so the canonical form is lower-case).
export function normalizePath(pathname) {
  const bare = String(pathname == null ? '/' : pathname).split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
  return bare === '' ? '/' : bare
}

export function findPublicPage(pathname) {
  const want = normalizePath(pathname)
  return publicPages().find(p => p.path === want) || null
}

// Which origin a page's canonical link must name. The same build is also reachable at www.usepassthrough.com and at
// the project's *.pages.dev addresses (production alias and every preview deployment); a canonical built from
// whatever host the visitor happened to use would make each of those a self-canonical duplicate of the real site.
// Local development and tests keep their own origin.
export function canonicalOriginFor(hostname, currentOrigin) {
  const host = String(hostname || '').toLowerCase()
  const ours = new URL(SITE_ORIGIN).hostname
  if (host === ours || host === `www.${ours}` || host.endsWith('.pages.dev')) return SITE_ORIGIN
  return currentOrigin
}

// Structural problems with the registry, as readable strings ([] when it is sound). The build throws on any (a malformed
// sitemap must never ship) and the tests assert none, so a typo is caught on the pull request, not after a deploy.
const SEGMENT = /^[a-z0-9_-]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
export function validatePublicPages(pages = publicPages()) {
  const problems = []
  const seen = new Set()
  pages.forEach((p, i) => {
    const at = `entry ${i}${p && typeof p.path === 'string' ? ` (${p.path})` : ''}`
    if (!p || typeof p !== 'object') { problems.push(`${at}: not an object`); return }
    if (typeof p.path !== 'string' || !p.path.startsWith('/')) { problems.push(`${at}: path must be a string starting with "/"`); return }
    if (p.path !== '/' && !p.path.slice(1).split('/').every(s => SEGMENT.test(s))) {
      problems.push(`${at}: path must be lower-case letters, digits, "-" and "_" in each segment, with no trailing slash, query or extension`)
    }
    if (seen.has(p.path)) problems.push(`${at}: duplicate path`)
    seen.add(p.path)
    if (typeof p.title !== 'string' || !p.title.trim()) problems.push(`${at}: title is required`)
    if (typeof p.description !== 'string' || !p.description.trim()) problems.push(`${at}: description is required`)
    if (p.lastmod != null && !(typeof p.lastmod === 'string' && DATE.test(p.lastmod) && !Number.isNaN(Date.parse(p.lastmod)))) {
      problems.push(`${at}: lastmod must be a real YYYY-MM-DD date`)
    }
    if (p.source != null && !(Array.isArray(p.source) && p.source.every(s => typeof s === 'string' && s))) {
      problems.push(`${at}: source must be an array of repo-relative paths`)
    }
  })
  return problems
}
