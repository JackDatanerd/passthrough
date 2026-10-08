import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet } from '../functions/v/[code].js'

// Round-5 (Section 7, G5): the /v/:code Pages Function ran an API round trip (up to 3s) before every
// first byte of HTML, for every visitor, and sent crawler junk-URL probes to the API as "misses".
const CODE = 'AB3XY7K2PQ'
let fetchMock, pending, store
const HAD = { fetch: globalThis.fetch, caches: globalThis.caches, HTMLRewriter: globalThis.HTMLRewriter }

function ctx(code = CODE, env = { API_URL: 'https://api.example/api' }) {
  return {
    params: { code }, env, request: { url: `https://passthrough.dev/v/${code}` },
    next: async () => new Response('<html><head><title>x</title></head></html>'),
    waitUntil: p => { pending.push(p) },
  }
}
const apiOk = (data = { atsScore: 85, passed: true, candidateFirstName: 'Ada' }) => new Response(JSON.stringify({ success: true, data }), { status: 200 })

beforeEach(() => {
  pending = []; store = new Map()
  fetchMock = vi.fn()
  globalThis.fetch = fetchMock
  globalThis.HTMLRewriter = class { on() { return this } transform(r) { return r } }
  globalThis.caches = { default: {
    match: async req => { const r = store.get(req.url); return r ? r.clone() : undefined },
    put: async (req, res) => { store.set(req.url, res.clone()) },
  } }
})
afterEach(() => {
  for (const [k, v] of Object.entries(HAD)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v }
})

describe('/v/:code preview Function', () => {
  it('a URL that cannot be a code never reaches the API', async () => {
    for (const junk of ['wp-login.php', 'AB3', '../etc/passwd', 'x'.repeat(40)]) await onRequestGet(ctx(junk))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks the API for a preview (no view counted) with the shared key when configured', async () => {
    fetchMock.mockResolvedValue(apiOk())
    await onRequestGet(ctx(CODE, { API_URL: 'https://api.example', VERIFY_PREVIEW_KEY: 'k' }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://api.example/api/verify/${CODE}?preview=1`)
    expect(init.headers).toEqual({ 'x-preview-key': 'k' })
  })

  it('the answer is cached: the second visit makes no API call', async () => {
    fetchMock.mockResolvedValue(apiOk())
    await onRequestGet(ctx()); await Promise.all(pending)
    await onRequestGet(ctx())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the cache key ignores the code\'s case, so /v/ab3… and /v/AB3… share one entry', async () => {
    fetchMock.mockResolvedValue(apiOk())
    await onRequestGet(ctx(CODE.toLowerCase())); await Promise.all(pending)
    await onRequestGet(ctx(CODE))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([404, 410])('a stable "no preview" answer (%s) is cached too', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    await onRequestGet(ctx()); await Promise.all(pending)
    await onRequestGet(ctx())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([[500], [429], [503]])('a transient failure (%s) is NOT cached — the next visit retries', async status => {
    fetchMock.mockResolvedValue(new Response('{}', { status }))
    await onRequestGet(ctx()); await Promise.all(pending)
    await onRequestGet(ctx())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a network error / timeout is NOT cached and never breaks the page', async () => {
    fetchMock.mockRejectedValue(new Error('aborted'))
    const res = await onRequestGet(ctx()); await Promise.all(pending)
    expect(await res.text()).toContain('<html>')
    await onRequestGet(ctx())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still works with no Cache API at all (local dev)', async () => {
    delete globalThis.caches
    fetchMock.mockResolvedValue(apiOk())
    const res = await onRequestGet(ctx())
    expect(res).toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('without API_URL it is a pure pass-through', async () => {
    const res = await onRequestGet(ctx(CODE, {}))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await res.text()).toContain('<html>')
  })
})
