import { describe, it, expect, afterEach } from 'vitest'
import { badgeCacheKeyForCode, purgeBadgeCache } from '../src/lib/badgeCache.js'

// SECTION 7 AUDIT FIX (bug): the embeddable badge is cached at Cloudflare's edge, but nothing
// ever invalidated that cache when the underlying scan's verification state changed — a
// revoked/restored page's badge could keep answering its PRE-change state for up to 5 minutes,
// the one surface a viewer never clicks through to double-check. This module is what makes
// purging possible from outside a request (a revoke can run from a webhook, an admin action,
// or a cron sweep, none of which have a real request origin to rebuild the old, request-derived
// cache key from) — see the file's own header comment for the full explanation.

function fakeCaches() {
  const store = new Map()
  const keyOf = req => req.url
  return {
    default: {
      async match(req) { return store.get(keyOf(req)) ?? undefined },
      async put(req, res) { store.set(keyOf(req), res) },
      async delete(req) { return store.delete(keyOf(req)) },
    },
    _store: store,
  }
}

const realCaches = globalThis.caches
afterEach(() => {
  if (realCaches === undefined) delete globalThis.caches
  else globalThis.caches = realCaches
})

describe('badgeCacheKeyForCode', () => {
  it('is stable for the same code and distinct for different codes', () => {
    expect(badgeCacheKeyForCode('AB3XY7').url).toBe(badgeCacheKeyForCode('AB3XY7').url)
    expect(badgeCacheKeyForCode('AB3XY7').url).not.toBe(badgeCacheKeyForCode('QZ9KP2').url)
  })
  it('does NOT depend on any request origin (purgeable from outside a request)', () => {
    // Two "requests" that would have arrived on different hosts (workers.dev preview vs a
    // custom domain, or a cron job with no host at all) must still key the same code the same
    // way, or a purge issued from a non-request context could never find what getBadge cached.
    expect(badgeCacheKeyForCode('AB3XY7').url).toContain('AB3XY7')
  })
})

describe('purgeBadgeCache', () => {
  it('deletes exactly the entry getBadge would have cached for that code, and nothing else', async () => {
    globalThis.caches = fakeCaches()
    await globalThis.caches.default.put(badgeCacheKeyForCode('AB3XY7'), new Response('<svg>old</svg>'))
    await globalThis.caches.default.put(badgeCacheKeyForCode('QZ9KP2'), new Response('<svg>untouched</svg>'))
    await purgeBadgeCache('AB3XY7')
    expect(await globalThis.caches.default.match(badgeCacheKeyForCode('AB3XY7'))).toBeUndefined()
    expect(await globalThis.caches.default.match(badgeCacheKeyForCode('QZ9KP2'))).toBeDefined()
  })
  it('is a silent no-op with no code, and with no Cache API available (local dev/tests)', async () => {
    delete globalThis.caches
    await expect(purgeBadgeCache('AB3XY7')).resolves.toBeUndefined()   // no `caches` global — never throws
    globalThis.caches = fakeCaches()
    await expect(purgeBadgeCache(null)).resolves.toBeUndefined()
    await expect(purgeBadgeCache(undefined)).resolves.toBeUndefined()
  })
  it('never throws even if the Cache API itself does', async () => {
    globalThis.caches = { default: { delete: async () => { throw new Error('edge hiccup') } } }
    await expect(purgeBadgeCache('AB3XY7')).resolves.toBeUndefined()
  })
})
