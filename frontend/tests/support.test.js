import { describe, it, expect, vi, afterEach } from 'vitest'

// SUPPORT-INBOXES ROUND 1: the one place the site's support address is decided (frontend/src/lib/support.js).
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('lib/support', () => {
  it('defaults to support@usepassthrough.com and builds the mailto from it', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', '')
    const m = await import('../src/lib/support.js')
    expect(m.SUPPORT_EMAIL).toBe('support@usepassthrough.com')
    expect(m.SUPPORT_MAILTO).toBe('mailto:support@usepassthrough.com')
  })
  it('honours a valid VITE_SUPPORT_EMAIL', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', ' help@example.com ')
    const m = await import('../src/lib/support.js')
    expect(m.SUPPORT_EMAIL).toBe('help@example.com')
    expect(m.SUPPORT_MAILTO).toBe('mailto:help@example.com')
  })
  it('ignores a malformed override — a bad build variable never reaches a mailto link', async () => {
    for (const bad of ['not an address', 'a@b', 'x@y.com, z@w.com', '<script>@x.com']) {
      vi.stubEnv('VITE_SUPPORT_EMAIL', bad); vi.resetModules()
      expect((await import('../src/lib/support.js')).SUPPORT_EMAIL).toBe('support@usepassthrough.com')
    }
  })
})
