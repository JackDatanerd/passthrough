import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// lib/api.js is the one piece of the shared frontend with real side effects
// (localStorage writes, forced navigation, automatic retries) and, before
// this file, NO test exercised the actual axios wiring — only its pure
// dependencies (session.js, errors.js, apiUrl.js) were tested in isolation.
// This tests the interceptor chain itself: token attachment, the FormData
// timeout bump, endSession's redirect/no-redirect branching and its
// same-tick dedupe, the admin-403 redirect, and the automatic GET retry.
//
// This suite runs under vitest.config.mjs's `node` environment (see that
// file's own comment — no DOM is installed), so `window`/`localStorage`/
// `CustomEvent` don't exist globally. Each test builds minimal stand-ins,
// following the same save/restore-around-globalThis convention used in
// frontend/tests/utils.test.js. Every request supplies its own `adapter` so
// nothing here ever attempts a real network call — axios runs the request
// through the same interceptors either way.
//
// The module keeps one piece of state at module scope (`sessionEnding`,
// used to dedupe several in-flight requests failing at once) that isn't
// reset between calls, so each test re-imports the module fresh via
// vi.resetModules() rather than share one instance across the whole file.

const TOKEN_KEY = 'passthrough_token'
const USER_KEY = 'passthrough_user'
const SESSION_ENDED_EVENT = 'passthrough:session-ended'

function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  }
}

let realWindow, realLocalStorage, realCustomEvent

function setGlobals({ pathname = '/dashboard', search = '', token } = {}) {
  const localStorage = makeLocalStorage(token ? { [TOKEN_KEY]: token } : {})
  const replace = vi.fn()
  const dispatchEvent = vi.fn()
  class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail }
  }
  const window = { location: { pathname, search, replace }, dispatchEvent, CustomEvent }
  globalThis.localStorage = localStorage
  globalThis.window = window
  globalThis.CustomEvent = CustomEvent
  return { localStorage, window, replace, dispatchEvent }
}

beforeEach(() => {
  realWindow = globalThis.window
  realLocalStorage = globalThis.localStorage
  realCustomEvent = globalThis.CustomEvent
  vi.resetModules()
})

afterEach(() => {
  globalThis.window = realWindow
  globalThis.localStorage = realLocalStorage
  globalThis.CustomEvent = realCustomEvent
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function loadApi() {
  const mod = await import('../src/lib/api.js')
  return mod.default
}

// Builds an axios adapter that never touches the network. `results` is a
// queue of either { data, status } (resolve) or { error: {...} } (reject);
// each call to the adapter shifts one off and records the config it saw.
function fakeAdapter(results) {
  const calls = []
  return {
    calls,
    adapter: async config => {
      calls.push(config)
      const next = results[calls.length - 1] ?? results[results.length - 1]
      if (next.error) {
        const err = new Error(next.error.message || 'Request failed')
        err.isAxiosError = true
        err.config = config
        err.code = next.error.code
        if (next.error.response) err.response = { headers: {}, ...next.error.response }
        else err.request = {}
        throw err
      }
      return { data: next.data, status: next.status ?? 200, statusText: 'OK', headers: {}, config }
    },
  }
}

describe('request interceptor', () => {
  it('attaches Authorization when a token is stored, and marks __hadToken', async () => {
    setGlobals({ token: 'tok123' })
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ data: {} }])
    await api.get('/scan/history', { adapter })
    expect(calls[0].headers.Authorization).toBe('Bearer tok123')
    expect(calls[0].__hadToken).toBe(true)
  })

  it('sends no Authorization header and __hadToken:false when logged out', async () => {
    setGlobals({})
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ data: {} }])
    await api.get('/scan/history', { adapter })
    expect(calls[0].headers.Authorization).toBeUndefined()
    expect(calls[0].__hadToken).toBe(false)
  })

  it('bumps a FormData upload past the 30s default timeout', async () => {
    setGlobals({})
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ data: {} }])
    const fd = new FormData()
    await api.post('/scan', fd, { adapter })
    expect(calls[0].timeout).toBe(180_000)
  })

  it('leaves an explicit custom timeout on a FormData upload alone', async () => {
    setGlobals({})
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ data: {} }])
    const fd = new FormData()
    await api.post('/scan', fd, { adapter, timeout: 5000, __customTimeout: true })
    expect(calls[0].timeout).toBe(5000)
  })

  it('does not touch the timeout for a non-FormData request', async () => {
    setGlobals({})
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ data: {} }])
    await api.get('/scan/history', { adapter })
    expect(calls[0].timeout).toBe(30_000)
  })
})

describe('endSession via the response interceptor', () => {
  it('an expired session on a protected path clears storage, fires the event, and redirects with ?next=', async () => {
    const { localStorage, window, replace, dispatchEvent } = setGlobals({ pathname: '/dashboard/settings', search: '?tab=account', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 401, data: {} } } }])
    await expect(api.get('/auth/me', { adapter })).rejects.toBeTruthy()

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0][0].type).toBe(SESSION_ENDED_EVENT)
    expect(dispatchEvent.mock.calls[0][0].detail).toEqual({ reason: 'expired' })
    expect(replace).toHaveBeenCalledWith('/login?expired=true&next=' + encodeURIComponent('/dashboard/settings?tab=account'))
  })

  it('a banned account is redirected from ANY path, not just protected ones', async () => {
    const { replace } = setGlobals({ pathname: '/', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 403, data: { code: 'BANNED' } } } }])
    await expect(api.get('/scan/history', { adapter })).rejects.toBeTruthy()
    expect(replace).toHaveBeenCalledWith('/login?banned=true')
  })

  it('an expired session on a PUBLIC path clears storage but does not redirect', async () => {
    const { localStorage, replace, dispatchEvent } = setGlobals({ pathname: '/', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 401, data: {} } } }])
    await expect(api.get('/profile', { adapter })).rejects.toBeTruthy()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })

  it('a 401 with no token attached is not treated as an expiry (nothing to expire)', async () => {
    const { replace, dispatchEvent } = setGlobals({ pathname: '/dashboard' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 401, data: {} } } }])
    await expect(api.get('/scan/history', { adapter })).rejects.toBeTruthy()
    expect(dispatchEvent).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('a failed login is never treated as a session expiry, even with a stale token attached', async () => {
    const { replace, dispatchEvent } = setGlobals({ pathname: '/login', token: 'stale' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 401, data: { message: 'Invalid credentials' } } } }])
    await expect(api.post('/auth/login', { email: 'a@b.com', password: 'x' }, { adapter })).rejects.toBeTruthy()
    expect(dispatchEvent).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('several in-flight requests failing at once only end the session once', async () => {
    const { dispatchEvent, replace } = setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([
      { error: { response: { status: 401, data: {} } } },
      { error: { response: { status: 401, data: {} } } },
      { error: { response: { status: 401, data: {} } } },
    ])
    await Promise.allSettled([
      api.get('/a', { adapter }),
      api.get('/b', { adapter }),
      api.get('/c', { adapter }),
    ])
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('sessionEnding unblocks again after the public-page no-redirect branch', async () => {
    vi.useFakeTimers()
    const { dispatchEvent } = setGlobals({ pathname: '/', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 401, data: {} } } }])
    await expect(api.get('/profile', { adapter })).rejects.toBeTruthy()
    expect(dispatchEvent).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)

    globalThis.localStorage.setItem(TOKEN_KEY, 'tok') // a second, unrelated session
    const { adapter: adapter2 } = fakeAdapter([{ error: { response: { status: 401, data: {} } } }])
    await expect(api.get('/profile', { adapter: adapter2 })).rejects.toBeTruthy()
    expect(dispatchEvent).toHaveBeenCalledTimes(2) // not swallowed by the earlier dedupe
  })
})

describe('admin 403 redirect', () => {
  it('a 403 on an /admin page with no session-expiry verdict bounces to /dashboard', async () => {
    const { replace } = setGlobals({ pathname: '/admin/partners', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 403, data: { message: 'Forbidden' } } } }])
    await expect(api.get('/admin/partners', { adapter })).rejects.toBeTruthy()
    expect(replace).toHaveBeenCalledWith('/dashboard')
  })

  it('does not fire outside /admin', async () => {
    const { replace } = setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const { adapter } = fakeAdapter([{ error: { response: { status: 403, data: {} } } }])
    await expect(api.get('/scan/1', { adapter })).rejects.toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('automatic retry', () => {
  it('retries a GET once after a transient (no-response) failure, then resolves', async () => {
    vi.useFakeTimers()
    setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([
      { error: {} },              // first call: no `response` at all -> network blip
      { data: { ok: true } },     // retry: succeeds
    ])
    const promise = api.get('/scan/history', { adapter })
    await vi.advanceTimersByTimeAsync(800)
    const res = await promise
    expect(calls.length).toBe(2)
    expect(res.data).toEqual({ ok: true })
  })

  it('never retries a POST, even after a transient failure', async () => {
    setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ error: {} }])
    await expect(api.post('/scan', {}, { adapter })).rejects.toBeTruthy()
    expect(calls.length).toBe(1)
  })

  it('does not retry a request that failed after already being retried once', async () => {
    vi.useFakeTimers()
    setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const { adapter, calls } = fakeAdapter([{ error: {} }, { error: {} }])
    const promise = api.get('/scan/history', { adapter })
    await vi.advanceTimersByTimeAsync(800)
    await expect(promise).rejects.toBeTruthy()
    expect(calls.length).toBe(2) // original + exactly one retry, not more
  })
})

describe('Blob error bodies are normalized before anything else sees them', () => {
  it('a Blob-shaped JSON error body arrives as a parsed object at the rejection', async () => {
    setGlobals({ pathname: '/dashboard', token: 'tok' })
    const api = await loadApi()
    const blob = new Blob([JSON.stringify({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify first' })])
    const { adapter } = fakeAdapter([{ error: { response: { status: 403, data: blob } } }])
    try {
      await api.get('/scan/1/download?type=pdf', { adapter, responseType: 'blob' })
      throw new Error('expected the request to reject')
    } catch (err) {
      expect(err.response.data).toEqual({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify first' })
    }
  })
})
