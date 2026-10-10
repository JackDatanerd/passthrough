import { describe, it, expect, afterEach } from 'vitest'
import { webhookUrl, postAlertWebhook } from '../src/lib/alertWebhook.js'
import { checkEmailDelivery, checkStorage } from '../src/lib/health.js'

const realFetch = global.fetch
afterEach(() => { global.fetch = realFetch })

describe('alert webhook (G2)', () => {
  it('only an https URL is usable; unset is a quiet no-op', async () => {
    expect(webhookUrl({})).toBeNull()
    expect(webhookUrl({ ALERT_WEBHOOK_URL: 'http://x.dev/h' })).toBeNull()
    expect(webhookUrl({ ALERT_WEBHOOK_URL: 'not a url' })).toBeNull()
    expect(webhookUrl({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc' })).toBe('https://hooks.example.com/abc')
    global.fetch = async () => { throw new Error('must not be called') }
    expect(await postAlertWebhook({}, 's', 'm')).toBe(false)
  })
  it('posts Slack- and Discord-shaped JSON, truncated, and reports success', async () => {
    let body
    global.fetch = async (url, init) => { body = JSON.parse(init.body); return new Response('ok', { status: 200 }) }
    expect(await postAlertWebhook({ ALERT_WEBHOOK_URL: 'https://h.example.com/x' }, 'Subj', 'x'.repeat(5000))).toBe(true)
    expect(body.text).toMatch(/^\[Passthrough Alert\] Subj/)
    expect(body.content).toBe(body.text)
    expect(body.text.length).toBeLessThanOrEqual(1800)
  })
  it('never throws: a non-2xx or a network failure just returns false', async () => {
    global.fetch = async () => new Response('no', { status: 500 })
    expect(await postAlertWebhook({ ALERT_WEBHOOK_URL: 'https://h.example.com/x' }, 's', 'm')).toBe(false)
    global.fetch = async () => { throw new Error('boom') }
    expect(await postAlertWebhook({ ALERT_WEBHOOK_URL: 'https://h.example.com/x' }, 's', 'm')).toBe(false)
  })
})

const emailDb = rows => ({ from: () => ({ select: () => ({ gte: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) })
describe('health probes (G2)', () => {
  it('email delivery is DOWN only when several sends failed and none succeeded in the hour', async () => {
    const f = n => Array(n).fill({ status: 'failed' })
    expect((await checkEmailDelivery(emailDb([...f(6)]))).ok).toBe(false)
    expect((await checkEmailDelivery(emailDb([...f(6), { status: 'sent' }]))).ok).toBe(true)
    expect((await checkEmailDelivery(emailDb(f(2)))).ok).toBe(true)
    expect((await checkEmailDelivery(emailDb([]))).ok).toBe(true)
  })
  it('an unreadable email_logs never fails health', async () => {
    const db = { from: () => ({ select: () => ({ gte: () => ({ limit: async () => ({ data: null, error: { message: 'x' } }) }) }) }) }
    expect((await checkEmailDelivery(db)).ok).toBe(true)
  })
  it('R2 probe: reachable bucket ok, throwing bucket reported, missing binding skipped', async () => {
    expect((await checkStorage({ RESUMES_BUCKET: { head: async () => null } })).ok).toBe(true)
    const bad = await checkStorage({ RESUMES_BUCKET: { head: async () => { throw new Error('down') } } })
    expect(bad.ok).toBe(false)
    expect(bad.detail).toMatch(/down/)
    expect((await checkStorage({})).skipped).toBe(true)
  })
})
