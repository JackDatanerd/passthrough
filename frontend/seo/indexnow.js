// IndexNow: tells Bing, Yandex, Seznam, Naver and Yep (one request reaches all of them) that URLs are new or changed, so
// they crawl them in minutes instead of whenever they next revisit. Google does not take part in IndexNow; it
// re-reads the sitemap by itself. Pure logic only: the CLI that does the git and network work is scripts/indexnow.mjs.
//
// The key is NOT a secret. IndexNow proves you own the site by fetching https://<site>/<key>.txt, so the key is
// published by design (frontend/public/<key>.txt). To rotate it, change it here and rename that file.
import { SITE_ORIGIN } from '../src/lib/publicPages.js'
import { parseBuildMarker } from './render.js'

export const INDEXNOW_KEY = '3fa59d6e2d5d67a36c0fea096c93f298'
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'
export const MAX_URLS_PER_REQUEST = 10000

const fingerprint = p => JSON.stringify([p.path, p.title, p.description, p.lastmod || ''])

// True when any changed file is one of the page's source files (a trailing "/" in `source` means a whole folder).
export function sourceTouched(source, changedFiles) {
  return (source || []).some(s => (s.endsWith('/') ? changedFiles.some(f => f.startsWith(s)) : changedFiles.includes(s)))
}

// The pages to announce for one push: new ones, ones whose title/description/lastmod changed, and ones whose source
// files were edited. `before` is the registry as of the previous commit ([] for a first run); `all` announces everything.
export function changedPages({ before = [], after, changedFiles = [], all = false }) {
  if (all) return [...after]
  const old = new Map(before.map(p => [p.path, p]))
  return after.filter(p => {
    const prev = old.get(p.path)
    return !prev || fingerprint(prev) !== fingerprint(p) || sourceTouched(p.source, changedFiles)
  })
}

export function indexNowPayload(urls, { origin = SITE_ORIGIN, key = INDEXNOW_KEY } = {}) {
  return { host: new URL(origin).hostname, key, keyLocation: `${origin}/${key}.txt`, urlList: urls }
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms))

// POST the URLs (in chunks of at most 10,000). 200 and 202 mean accepted; 429 and 5xx are retried with a growing wait;
// anything else (403 key not found at keyLocation, 422 URL not on this host, 400 malformed) is a real error.
export async function submitIndexNow(urls, { fetchImpl = fetch, endpoint = INDEXNOW_ENDPOINT, origin, key, sleep = defaultSleep, attempts = 4 } = {}) {
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
    const body = JSON.stringify(indexNowPayload(urls.slice(i, i + MAX_URLS_PER_REQUEST), { origin, key }))
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body })
      if (res.status === 200 || res.status === 202) break
      const retryable = res.status === 429 || res.status >= 500
      if (!retryable || attempt >= attempts) {
        const text = typeof res.text === 'function' ? await res.text().catch(() => '') : ''
        throw new Error(`IndexNow answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
      }
      await sleep(5000 * 3 ** (attempt - 1))
    }
  }
}

// Waits until the LIVE sitemap carries a build marker for `sha` (or for a commit that came after it, which contains it):
// announcing a page before its deploy lands would send crawlers to the old version. Resolves true when live, false on timeout.
export async function waitForDeploy({ origin = SITE_ORIGIN, sha, isAncestor = () => false, fetchImpl = fetch, sleep = defaultSleep, now = Date.now, timeoutMs = 25 * 60 * 1000, intervalMs = 20000 }) {
  const deadline = now() + timeoutMs
  for (;;) {
    try {
      const res = await fetchImpl(`${origin}/sitemap.xml?indexnow=${now()}`, { headers: { 'Cache-Control': 'no-cache' } })
      if (res.ok) {
        const live = parseBuildMarker(await res.text())
        if (live && (live === sha || isAncestor(sha, live))) return true
      }
    } catch (_) { /* the site is mid-deploy or unreachable: keep waiting */ }
    if (now() + intervalMs > deadline) return false
    await sleep(intervalMs)
  }
}
