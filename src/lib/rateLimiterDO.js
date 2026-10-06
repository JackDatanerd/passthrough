// Durable Object that owns ONE rate-limit key (the Worker addresses it with
// idFromName(key)). A Durable Object processes one request at a time per
// instance, and every operation below is also run through an explicit promise
// chain, so a get-then-put is atomic no matter how many requests arrive in the
// same instant — the property Workers KV cannot give. The algorithms themselves
// live in lib/rateLimitCore.js (shared with the KV fallback).
//
// Storage: SQLite-backed (see the `new_sqlite_classes` migration in
// wrangler.toml). Values carry their own expiry; an alarm deletes the object's
// storage once the last write has expired, so idle keys cost nothing.
//
// Written without importing 'cloudflare:workers' so it loads (and is tested) in
// plain Node: a Durable Object only needs a constructor(state, env) and fetch().

const { OPS } = require('./rateLimitCore')

class RateLimiterDO {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.chain = Promise.resolve()
  }

  _store() {
    const storage = this.state.storage
    return {
      get: async key => {
        const rec = await storage.get(key)
        if (!rec) return null
        if (typeof rec.exp === 'number' && rec.exp <= Date.now()) { await storage.delete(key); return null }
        return rec.v
      },
      put: async (key, value, opts = {}) => {
        const exp = Date.now() + ((opts.expirationTtl || 3600) * 1000)
        await storage.put(key, { v: value, exp })
        // Sweep this object's storage shortly after the latest expiry.
        await storage.setAlarm(exp + 1000)
      },
      delete: async key => { await storage.delete(key) },
    }
  }

  async fetch(request) {
    let body
    try { body = await request.json() } catch (_) { return new Response('bad request', { status: 400 }) }
    const op = OPS[body && body.op]
    if (!op) return new Response('unknown op', { status: 400 })
    const run = this.chain.then(() => op(this._store(), body.args || {}))
    this.chain = run.catch(() => {})   // one failure must not poison the queue
    try {
      return Response.json((await run) ?? { ok: true })
    } catch (err) {
      return new Response(String(err && err.message || err), { status: 500 })
    }
  }

  async alarm() {
    // Everything this object holds has expired by the time the alarm fires
    // (each write re-arms it past its own expiry) — but re-check, since a newer
    // write may have moved the alarm and this one is stale.
    const all = await this.state.storage.list()
    const now = Date.now()
    let live = false
    for (const [k, rec] of all) {
      if (rec && typeof rec.exp === 'number' && rec.exp <= now) await this.state.storage.delete(k)
      else live = true
    }
    if (live) {
      let latest = now
      for (const [, rec] of await this.state.storage.list()) if (rec && rec.exp > latest) latest = rec.exp
      await this.state.storage.setAlarm(latest + 1000)
    }
  }
}

module.exports = { RateLimiterDO }
