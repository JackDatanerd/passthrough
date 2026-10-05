import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Auth round 2: the SPA keeps its session token in localStorage, so its response headers
// carry a Content-Security-Policy that stops injected script from running. A future edit
// that quietly drops or loosens the script policy should fail here, not in production.
const headers = readFileSync(fileURLToPath(new URL('../public/_headers', import.meta.url)), 'utf8')
const csp = (headers.split(/\r?\n/).find(l => /^\s*Content-Security-Policy:/i.test(l)) || '').replace(/^\s*Content-Security-Policy:\s*/i, '')
const directive = name => (csp.split(';').map(d => d.trim()).find(d => d.startsWith(name + ' ')) || '')

describe('SPA Content-Security-Policy (frontend/public/_headers)', () => {
  it('is present on the catch-all rule', () => {
    expect(csp).not.toBe('')
    expect(headers.indexOf('/*')).toBeLessThan(headers.search(/Content-Security-Policy:/i))
  })
  it('only runs same-origin scripts — no inline, eval or third-party script', () => {
    const script = directive('script-src')
    // Turnstile (employer-lead bot challenge) is the one allowed third-party script host.
    expect(script).toBe("script-src 'self' https://challenges.cloudflare.com")
    expect(csp).not.toMatch(/unsafe-eval/)
  })
  it('blocks plugins, base-tag hijack and framing', () => {
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('base-uri')).toBe("base-uri 'self'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
  })
})
