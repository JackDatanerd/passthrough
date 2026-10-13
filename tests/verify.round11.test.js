import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
import { sha256Bytes } from '../src/lib/crypto.js'
import { postAlertWebhook, neutralizeChatMarkup } from '../src/lib/alertWebhook.js'

// Round-11 (fresh clone) audit of Section 7 (Verify).
const CODE = 'AB3XY7K2PQ'
const DOCX = new TextEncoder().encode('docx contents')
const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const realFetch = global.fetch
let t
afterEach(() => { global.fetch = realFetch; t?.restore() })

describe('V-1: a stranger\'s text cannot ping or phish through the alert webhook', () => {
  const HOSTILE = '@everyone @here @channel <!channel> <!here> <@U123ABC> <@&998877> <https://evil.example/login|Passthrough admin sign-in> [Sign in](https://evil.example)'

  it('neutralizeChatMarkup breaks every mention / link token and keeps the text readable', () => {
    const out = neutralizeChatMarkup(HOSTILE)
    expect(out).not.toMatch(/<[!@#&a-z/]/i)             // no angle-bracket token survives
    expect(out).not.toMatch(/@(?:everyone|here|channel|all)\b/i)
    expect(out).not.toContain('](')
    expect(out.replace(/​/g, '')).toBe(HOSTILE)   // only zero-width characters were added
  })
  it('leaves ordinary alert text alone (an e-mail address, a plain URL, numbers)', () => {
    const s = 'verification code: AB3XY7K2PQ\nreason: FAKE\nnote: mail jane@example.com about https://passthrough.dev/v/AB3XY7K2PQ (2 of 3)'
    expect(neutralizeChatMarkup(s)).toBe(s)
    expect(neutralizeChatMarkup(null)).toBe('')
  })
  it('the posted JSON is neutralised in text, content, subject and message, and tells Discord to parse no mentions', async () => {
    let body
    global.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response('ok', { status: 200 }) }
    await postAlertWebhook({ ALERT_WEBHOOK_URL: 'https://h.example.com/x' }, 'Reported <!here>', `note: ${HOSTILE}`)
    for (const k of ['text', 'content', 'subject', 'message']) {
      expect(body[k]).not.toMatch(/<[!@#&a-z/]/i)
      expect(body[k]).not.toMatch(/@(?:everyone|here|channel|all)\b/i)
    }
    expect(body.content).toBe(body.text)
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })
  it('neutralising happens before the length cut, so the cap still holds', async () => {
    let body
    global.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response('ok', { status: 200 }) }
    await postAlertWebhook({ ALERT_WEBHOOK_URL: 'https://h.example.com/x' }, 'S', '<'.repeat(5000))
    expect(body.text.length).toBeLessThanOrEqual(1800)
  })
  it('end to end: a report note carrying hostile markup reaches the webhook defused', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_code: CODE, verification_status: 'ACTIVE', user_id: null, resume_hash: await sha256Bytes(DOCX) }] })
    world.t.verification_reports = world.t.verification_reports || []
    const real = require('../src/lib/alertWebhook.js')
    const posted = []
    global.fetch = async (_u, init) => { posted.push(JSON.parse(init.body)); return new Response('ok', { status: 200 }) }
    const stubs = {
      'config/supabase.js': { getSupabase: () => world.db },
      'services/email.service.js': {
        sendOwnerAlert: async (env, subject, message) => { await real.postAlertWebhook(env, subject, message) },
        sendVerificationReported: async () => {},
      },
    }
    const loaded = loadWithStubs('controllers/verify.controller.js', stubs)
    t = loaded
    const kv = new Map(); const hdr = { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0' }
    const c = {
      env: { ALERT_WEBHOOK_URL: 'https://h.example.com/x', RATE_LIMIT_KV: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v) } }, NODE_ENV: 'production', FRONTEND_URL: 'https://x.dev' },
      req: { method: 'POST', param: () => CODE, query: () => undefined, header: n => hdr[n.toLowerCase()], json: async () => ({ reason: 'FAKE', details: HOSTILE }) },
      get: () => null, executionCtx: { waitUntil: () => {} }, header: () => {},
      json: (data, status = 200) => ({ status, data }), body: () => ({}),
    }
    const res = await loaded.mod.reportVerification(c)
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 0))
    expect(posted.length).toBeGreaterThan(0)
    expect(posted[0].text).toContain('note:')
    expect(posted[0].text).not.toMatch(/<[!@#&a-z/]/i)
    expect(posted[0].text).not.toMatch(/@(?:everyone|here|channel|all)\b/i)
  })
})

describe('badgeThreshold: the page names the bar the server judged against', () => {
  it('getVerification returns constants.ATS_BADGE_THRESHOLD', async () => {
    const world = createWorld({ scans: [{ id: 's1', verification_code: CODE, verification_status: 'ACTIVE', user_id: null, ats_score: 50, fix_ats_score: 60, verified_at: '2026-03-01T00:00:00Z', resume_ats_path: null, resume_hash: null, resume_hash_history: [], verify_expose_docx: false, verify_expose_pdf: false, verify_hide_name: false }] })
    world.rpcs.increment_verification_views = () => ({ data: null, error: null })
    t = loadWithStubs('controllers/verify.controller.js', { 'config/supabase.js': { getSupabase: () => world.db } })
    const hdr = { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 Chrome' }
    const c = {
      env: { NODE_ENV: 'production' },
      req: { method: 'GET', param: () => CODE, query: () => undefined, header: n => hdr[n.toLowerCase()] },
      get: () => null, executionCtx: { waitUntil: () => {} }, header: () => {},
      json: (data, status = 200) => ({ status, data }),
    }
    const r = await t.mod.getVerification(c)
    expect(r.data.data.badgeThreshold).toBe(require('../src/config/constants').ATS_BADGE_THRESHOLD)
  })
  it('Verify.jsx prefers the server value and keeps its constant only as a fallback', () => {
    expect(read('../frontend/src/pages/Verify.jsx')).toMatch(/Number\.isFinite\(data\.badgeThreshold\) \? data\.badgeThreshold : ATS_BADGE_THRESHOLD/)
  })
})
