import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { onRequestGet } from '../functions/v/[code].js'

// Round-7 (Section 7): the preview verdict is real now, so a verified page unfurls as "Passthrough
// Verified", and every card carries a per-page share image.
const CODE = 'AB3XY7K2PQ'
const HAD = { fetch: globalThis.fetch, caches: globalThis.caches, HTMLRewriter: globalThis.HTMLRewriter }
let handlers, metas, extra

function fakeEl(attrs) {
  const a = { ...attrs }
  return { a, getAttribute: k => a[k] ?? null, setAttribute: (k, v) => { a[k] = v }, setInnerContent: () => {}, append: () => {}, onEndTag: cb => cb({ before: html => { extra.push(html) } }) }
}

beforeEach(() => {
  handlers = {}; extra = []; metas = []
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } }
  globalThis.HTMLRewriter = class {
    on(sel, h) { handlers[sel] = h; return this }
    transform(r) { return r }
  }
})
afterEach(() => { for (const [k, v] of Object.entries(HAD)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v } })

async function run(data, staticMetas) {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data }), { status: 200 }))
  await onRequestGet({
    params: { code: CODE }, env: { API_URL: 'https://api.example/api' }, request: { url: `https://passthrough.dev/v/${CODE}` },
    next: async () => new Response('<html></html>'), waitUntil: () => {},
  })
  metas = staticMetas.map(fakeEl)
  for (const m of metas) handlers.meta.element(m)
  handlers.head.element(fakeEl({}))
  return Object.fromEntries(metas.map(m => [m.a.property || m.a.name, m.a.content]))
}

describe('/v/:code preview Function, round 7', () => {
  const full = [
    { property: 'og:title', content: 'x' }, { name: 'twitter:title', content: 'x' }, { property: 'og:description', content: 'x' },
    { property: 'og:image', content: '/logo.png' }, { name: 'twitter:image', content: '/logo.png' }, { name: 'twitter:card', content: 'summary' },
  ]
  it('a verified page unfurls as "Passthrough Verified" with the per-page card image', async () => {
    const out = await run({ atsScore: 85, passed: true, verified: true, candidateFirstName: 'Ada' }, full)
    expect(out['og:title']).toBe('Ada: Passthrough Verified — ATS score 85/100')
    expect(out['og:image']).toBe(`https://api.example/api/verify/${CODE}/card.png`)
    expect(out['twitter:image']).toBe(`https://api.example/api/verify/${CODE}/card.png`)
    expect(out['twitter:card']).toBe('summary_large_image')
    expect(extra).toEqual([])
  })
  it('a passing score without a verified verdict stays a scan report', async () => {
    const out = await run({ atsScore: 85, passed: true, verified: false }, full)
    expect(out['og:title']).toBe('Passthrough Scan Report — ATS score 85/100')
  })
  it('adds the image tags when the static page lacks them', async () => {
    await run({ atsScore: 85, passed: true, verified: true }, [{ property: 'og:title', content: 'x' }])
    const html = extra.join('')
    expect(html).toContain(`property="og:image" content="https://api.example/api/verify/${CODE}/card.png"`)
    expect(html).toContain('name="twitter:image"')
    expect(html).toContain('summary_large_image')
  })
})
