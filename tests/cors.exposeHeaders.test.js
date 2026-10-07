import { describe, it, expect } from 'vitest'
import { EXPOSED_HEADERS } from '../src/middleware/cors.js'

// The site and the API are different origins in production, so the browser hides every response
// header outside the CORS-safelisted set unless the Worker exposes it. The SPA reads Retry-After
// (its automatic 429 retry and its "wait N seconds" copy) and X-Export-Parts; losing either from this
// list fails silently in production and nowhere else. (The list lives in middleware/cors.js;
// tests/cors.middleware.test.js asserts the headers on real responses too.)
describe('CORS exposeHeaders (src/middleware/cors.js)', () => {
  it.each(['X-Export-Parts', 'Retry-After', 'Content-Disposition', 'X-Export-Truncated', 'X-Export-Rows', 'X-Export-Cursor'])('exposes %s to the browser', h => {
    expect(EXPOSED_HEADERS.map(x => x.toLowerCase())).toContain(h.toLowerCase())
  })
})
