import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Shared frontend round 16 (B2) — lib/api.js: after the person signs in again IN PLACE (session resume), a request that was
// still in flight under the OLD token and fails 401 afterwards is replayed once under the new token instead of surfacing a raw
// auth error to a person who is, by then, validly signed in.
const TOKEN_KEY = 'passthrough_token'
function makeLs(initial = {}) { const s = new Map(Object.entries(initial)); return { getItem: k => (s.has(k) ? s.get(k) : null), setItem: (k, v) => s.set(k, String(v)), removeItem: k => s.delete(k), clear: () => s.clear() } }
let saved
function globals({ pathname = '/dashboard/settings', token = 'a.b.c' } = {}) {
  const replace = vi.fn(), dispatchEvent = vi.fn()
  class CE { constructor(t, o) { this.type = t; this.detail = o?.detail } }
  globalThis.localStorage = makeLs({ [TOKEN_KEY]: token })
  globalThis.window = { location: { pathname, search: '', replace }, dispatchEvent, CustomEvent: CE }
  globalThis.CustomEvent = CE
  return { replace, dispatchEvent }
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
const expired = { status: 401, data: { code: 'TOKEN_EXPIRED', message: 'Session expired.' } }
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = sid => `${b64({ alg: 'HS256' })}.${b64({ sid })}.sig`

describe('stragglers from a session that was resumed in place', () => {
  async function setup(oldToken = 'a.b.c') {
    const env = globals({ token: oldToken })
    const mod = await import('../src/lib/api'); const api = mod.default
    const { markUnsaved } = await import('../src/lib/unsavedGuard')
    markUnsaved()
    return { ...env, mod, api }
  }

  it('a request still in flight under the old token is replayed under the new one after the resume', async () => {
    const { mod, api, replace, dispatchEvent } = await setup()
    mod.setSessionResumePrompt(async () => { globalThis.localStorage.setItem(TOKEN_KEY, 'n.e.w'); return true })
    let release; const gate = new Promise(r => { release = r })
    const seen = []
    api.defaults.adapter = adapterFor(async c => {
      if (c.url === '/slow') await gate
      seen.push(`${c.url} ${header(c, 'Authorization')}`)
      return header(c, 'Authorization') === 'Bearer n.e.w' ? { status: 200, data: { ok: c.url } } : expired
    })
    const slow = api.get('/slow')                 // sent under a.b.c, parked at the gate
    await api.put('/profile', { a: 1 })           // 401 -> prompt -> new token -> replay succeeds
    release()                                      // the straggler now fails 401 under a.b.c
    const res = await slow
    expect(res.data.ok).toBe('/slow')
    expect(seen.filter(s => s.startsWith('/slow'))).toEqual(['/slow Bearer a.b.c', '/slow Bearer n.e.w'])
    expect(replace).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()   // nobody was signed out
  })

  it('works when the tokens carry session ids (the real shape): old session id is what is remembered', async () => {
    const oldTok = jwt('S1'), newTok = jwt('S2')
    const { mod, api } = await setup(oldTok)
    mod.setSessionResumePrompt(async () => { globalThis.localStorage.setItem(TOKEN_KEY, newTok); return true })
    let release; const gate = new Promise(r => { release = r })
    api.defaults.adapter = adapterFor(async c => {
      if (c.url === '/slow') await gate
      return header(c, 'Authorization') === `Bearer ${newTok}` ? { status: 200, data: { ok: 1 } } : expired
    })
    const slow = api.get('/slow')
    await api.put('/profile', {})
    release()
    expect((await slow).data.ok).toBe(1)
  })

  it('is NOT replayed when the held token changed without a resume (signed in as someone else)', async () => {
    const { api, dispatchEvent } = await setup()
    let release; const gate = new Promise(r => { release = r })
    let sent; const wasSent = new Promise(r => { sent = r })
    let calls = 0
    api.defaults.adapter = adapterFor(async () => { calls++; sent(); await gate; return expired })
    const slow = api.get('/slow')
    await wasSent                                           // request interceptors are async: wait until it really left under a.b.c
    globalThis.localStorage.setItem(TOKEN_KEY, 'x.y.z')   // another account signed in elsewhere; no resume happened
    release()
    await expect(slow).rejects.toBeTruthy()
    expect(calls).toBe(1)                                   // never replayed under the other account
    expect(dispatchEvent).not.toHaveBeenCalled()            // and the other account was not signed out either
  })

  it('a straggler is replayed at most once: if the new token is refused too, the session ends normally', async () => {
    const { mod, api, replace } = await setup()
    mod.setSessionResumePrompt(async () => { globalThis.localStorage.setItem(TOKEN_KEY, 'n.e.w'); return true })
    let release; const gate = new Promise(r => { release = r })
    let slowCalls = 0
    api.defaults.adapter = adapterFor(async c => {
      if (c.url === '/slow') { slowCalls++; if (slowCalls === 1) await gate; return expired }
      return header(c, 'Authorization') === 'Bearer n.e.w' ? { status: 200, data: {} } : expired
    })
    const slow = api.get('/slow')
    await api.put('/profile', {})
    release()
    await expect(slow).rejects.toBeTruthy()
    expect(slowCalls).toBe(2)                               // original + exactly one replay, no loop
    expect(replace).toHaveBeenCalledTimes(1)                // the replay's own 401 ended the session the usual way
  })
})
