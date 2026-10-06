import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The site and the API are different origins in production, so the browser hides every response
// header outside the CORS-safelisted set unless the Worker exposes it. The SPA reads Retry-After
// (its automatic 429 retry and its "wait N seconds" copy) and X-Export-Parts; losing either from this
// list fails silently in production and nowhere else.
const src = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8')
const exposed = (/exposeHeaders:\s*\[([^\]]*)\]/.exec(src)?.[1] || '')
  .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '').toLowerCase()).filter(Boolean)

describe('CORS exposeHeaders (src/index.js)', () => {
  it.each(['X-Export-Parts', 'Retry-After', 'Content-Disposition'])('exposes %s to the browser', h => {
    expect(exposed).toContain(h.toLowerCase())
  })
})
