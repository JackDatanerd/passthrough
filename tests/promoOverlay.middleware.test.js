import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const promoConfig = require('../src/lib/promoConfig')
const record = { active: true, label: 'Flash sale', startsAt: null, endsAt: '2099-01-01T00:00:00.000Z', prices: { FIX: 2000, BADGE: 500, FIX_PLAIN: 1000 }, currency: 'USD' }
const env = { PAYSTACK_CURRENCY: 'USD', PROMO_ACTIVE: 'false' }

function appWith(db) {
  const { mod, restore } = loadWithStubs('middleware/promoOverlay.js', { 'config/supabase.js': { getSupabase: () => db } })
  const app = new Hono()
  app.use('/api/*', mod)
  app.get('/api/x', c => c.json({ active: c.env.PROMO_ACTIVE, label: c.env.PROMO_LABEL ?? null }))
  return { app, restore }
}
beforeEach(() => promoConfig.invalidate())

describe('promoOverlay middleware', () => {
  it('hands downstream handlers the admin promo without touching the shared env', async () => {
    const { app, restore } = appWith(createFakeSupabase(() => ({ data: { value: record } })))
    const res = await app.request('/api/x', {}, env)
    expect(await res.json()).toEqual({ active: 'true', label: 'Flash sale' })
    expect(env.PROMO_ACTIVE).toBe('false')
    restore()
  })
  it('falls through to the deploy settings when there is no record or the read fails', async () => {
    const a = appWith(createFakeSupabase(() => ({ data: null })))
    expect(await (await a.app.request('/api/x', {}, env)).json()).toEqual({ active: 'false', label: null })
    a.restore()
  })
})
