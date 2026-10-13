import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Shared frontend round 9 — lib/api.js: step-up failures are reported, a late refusal does not discard a fresh
// elevation, and an ended session is resumed in place (instead of redirected away) while unsaved work is held.
const TOKEN_KEY = 'passthrough_token'
function makeLs(initial = {}) { const s = new Map(Object.entries(initial)); return { getItem: k => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: k => s.delete(k), clear: () => s.clear() } }
let saved
function globals({ pathname = '/admin/payments', token = 'a.b.c' } = {}) {
  const replace = vi.fn()
  class CE { constructor(t, o) { this.type = t; this.detail = o?.detail } }
  globalThis.localStorage = makeLs({ [TOKEN_KEY]: token })
  globalThis.window = { location: { pathname, search: '', replace }, dispatchEvent: vi.fn(), CustomEvent: CE }
  globalThis.CustomEvent = CE
  return { replace }
}
beforeEach(() => { saved = [globalThis.window, globalThis.localStorage, globalThis.CustomEvent]; vi.resetModules() })
afterEach(() => { [globalThis.window, globalThis.localStorage, globalThis.CustomEvent] = saved })

function adapterFor(handler) {
  return async config => {
    const r = await handler(config)
    const res = { status: r.status, data: r.data, headers: r.headers || {}, config }
    if (r.status >= 400) { const e = new Error('x'); e.isAxiosError = true; e.config = config; e.response = res; throw e }
    return res
  }
}
const header = (config, name) => (config.headers.get ? config.headers.get(name) : config.headers[name])

describe('step-up', () => {
  it('reports why elevation failed (lockout) instead of the original "Confirm your password"', async () => {
    globals()
    const mod = await import('../src/lib/api'); const api = mod.default
    mod.setStepUpPrompt(async () => 'pw')
    api.defaults.adapter = adapterFor(c => c.url === '/admin/elevate'
      ? { status: 429, data: { message: 'Too many attempts. Try again in 15 minutes.', code: 'ACCOUNT_LOCKED' } }
      : { status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED', message: 'Confirm your password to continue.' } })
    const err = await api.post('/payments/refund', {}).catch(e => e)
    expect(err.response.status).toBe(429)
    expect(err.response.data.message).toMatch(/Too many attempts/)
  })

  it('a cancelled prompt still surfaces the original refusal', async () => {
    globals()
    const mod = await import('../src/lib/api'); const api = mod.default
    mod.setStepUpPrompt(async () => null)
    api.defaults.adapter = adapterFor(() => ({ status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED' } }))
    const err = await api.post('/payments/refund', {}).catch(e => e)
    expect(err.response.data.code).toBe('ADMIN_STEP_UP_REQUIRED')
  })

  it('a refusal of a request sent BEFORE the elevation does not discard it or ask again', async () => {
    globals()
    const mod = await import('../src/lib/api'); const api = mod.default
    let prompts = 0, elevations = 0, release
    const gate = new Promise(r => { release = r })
    mod.setStepUpPrompt(async () => { prompts++; return 'pw' })
    api.defaults.adapter = adapterFor(async c => {
      if (c.url === '/admin/elevate') { elevations++; return { status: 200, data: { data: { elevationToken: 'tok', expiresInSeconds: 600 } } } }
      if (c.url === '/admin/slow') await gate
      return header(c, 'X-Admin-Elevation') ? { status: 200, data: { ok: 1 } } : { status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED' } }
    })
    const slow = api.get('/admin/slow')
    await api.post('/payments/refund', {})
    release()
    const res = await slow
    expect(res.data.ok).toBe(1)
    expect(prompts).toBe(1)
    expect(elevations).toBe(1)
  })
})

describe('resuming an ended session in place', () => {
  const expired = { status: 401, data: { code: 'TOKEN_EXPIRED', message: 'Session expired.' } }

  it('with unsaved work: asks to sign in again, then replays the request with the NEW token', async () => {
    const { replace } = globals({ pathname: '/dashboard/settings' })
    const mod = await import('../src/lib/api'); const api = mod.default
    const { markUnsaved } = await import('../src/lib/unsavedGuard')
    markUnsaved()
    const prompt = vi.fn(async () => { globalThis.localStorage.setItem(TOKEN_KEY, 'n.e.w'); return true })
    mod.setSessionResumePrompt(prompt)
    const seen = []
    api.defaults.adapter = adapterFor(c => {
      seen.push(header(c, 'Authorization'))
      return header(c, 'Authorization') === 'Bearer n.e.w' ? { status: 200, data: { saved: true } } : expired
    })
    const res = await api.put('/profile', { a: 1 })
    expect(res.data.saved).toBe(true)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['Bearer a.b.c', 'Bearer n.e.w'])
    expect(replace).not.toHaveBeenCalled()
  })

  it('concurrent failures share one prompt', async () => {
    globals({ pathname: '/dashboard/settings' })
    const mod = await import('../src/lib/api'); const api = mod.default
    const { markUnsaved } = await import('../src/lib/unsavedGuard')
    markUnsaved()
    const prompt = vi.fn(async () => { globalThis.localStorage.setItem(TOKEN_KEY, 'n.e.w'); return true })
    mod.setSessionResumePrompt(prompt)
    api.defaults.adapter = adapterFor(c => header(c, 'Authorization') === 'Bearer n.e.w' ? { status: 200, data: {} } : expired)
    await Promise.all([api.put('/profile', {}), api.put('/profile/extras/1', {})])
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('"Discard" (false) falls back to the normal redirect', async () => {
    const { replace } = globals({ pathname: '/dashboard/settings' })
    const mod = await import('../src/lib/api'); const api = mod.default
    const { markUnsaved } = await import('../src/lib/unsavedGuard')
    markUnsaved()
    mod.setSessionResumePrompt(async () => false)
    api.defaults.adapter = adapterFor(() => expired)
    await api.put('/profile', {}).catch(() => {})
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace.mock.calls[0][0]).toMatch(/^\/login\?expired=true/)
  })

  it('without unsaved work the prompt is never shown', async () => {
    const { replace } = globals({ pathname: '/dashboard/settings' })
    const mod = await import('../src/lib/api'); const api = mod.default
    const prompt = vi.fn(async () => true)
    mod.setSessionResumePrompt(prompt)
    api.defaults.adapter = adapterFor(() => expired)
    await api.get('/auth/me').catch(() => {})
    expect(prompt).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('a banned account is never offered a resume', async () => {
    const { replace } = globals({ pathname: '/dashboard/settings' })
    const mod = await import('../src/lib/api'); const api = mod.default
    const { markUnsaved } = await import('../src/lib/unsavedGuard')
    markUnsaved()
    const prompt = vi.fn(async () => true)
    mod.setSessionResumePrompt(prompt)
    api.defaults.adapter = adapterFor(() => ({ status: 403, data: { code: 'BANNED' } }))
    await api.put('/profile', {}).catch(() => {})
    expect(prompt).not.toHaveBeenCalled()
    expect(replace.mock.calls[0][0]).toBe('/login?banned=true')
  })

  it('the unsaved-work registry counts and releases idempotently', async () => {
    const { markUnsaved, hasUnsavedWork } = await import('../src/lib/unsavedGuard')
    expect(hasUnsavedWork()).toBe(false)
    const a = markUnsaved(), b = markUnsaved()
    a(); a()
    expect(hasUnsavedWork()).toBe(true)
    b()
    expect(hasUnsavedWork()).toBe(false)
  })
})
