import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const require = createRequire(import.meta.url)
const constants = require('../src/config/constants.js')
const { scanRowToCamel, toClientScan } = require('../src/lib/mappers.js')

// Cover-letter limit (migration 0104): a letter is a paid model call, so each scan may have only so many written, by tier.

function ctx(over = {}) {
  return {
    env: { PAYSTACK_CURRENCY: 'USD' },
    get: k => (k === 'user' ? { id: 'u1', emailVerified: true } : undefined),
    req: { param: () => 's1', query: () => undefined, json: async () => over.body ?? {} },
    json: (body, status = 200) => ({ body, status }),
    header: () => {}, body: b => ({ rawBody: b }),
  }
}

let t
afterEach(() => t?.restore())

function setup({ tier = 'FIX', claim = 1, claimError = null, letter, lostRace = false, throwModel = false } = {}) {
  const state = { rpcs: [], modelCalls: 0 }
  const scan = {
    id: 's1', user_id: 'u1', status: 'FIX_DELIVERED', fix_purchased: true, fix_tier: tier, fix_retry_count: 0,
    job_description_text: 'JD ' + 'x'.repeat(60), rewritten_resume_data: { name: 'Jane' },
  }
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc') {
      state.rpcs.push({ name: q.name, args: q.args })
      if (q.name === 'claim_cover_letter_slot') return claimError ? { data: null, error: claimError } : { data: claim, error: null }
      return { data: null, error: null }
    }
    if (q.table === 'scans' && q.op === 'select') return { data: scan, error: null }
    if (q.table === 'scans' && q.op === 'update') return { data: lostRace ? [] : [{ id: 's1' }], error: null }
  })
  const { mod, restore } = loadWithStubs('controllers/scan.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/claude.service.js': {
      generateCoverLetter: async () => {
        state.modelCalls++
        if (throwModel) throw new Error('boom')
        return letter ?? { success: true, data: 'Dear Hiring Manager,\n\nHi.' }
      },
    },
  })
  return { mod, restore, state }
}

describe('cover-letter limits by tier', () => {
  it('gives each tier its own limit, more for the larger purchase', () => {
    expect(constants.coverLetterLimitFor('BADGE')).toBe(2)
    expect(constants.coverLetterLimitFor('FIX_PLAIN')).toBe(3)
    expect(constants.coverLetterLimitFor('FIX')).toBe(5)
    expect(constants.coverLetterLimitFor('FIX')).toBeGreaterThan(constants.coverLetterLimitFor('FIX_PLAIN'))
    expect(constants.coverLetterLimitFor('FIX_PLAIN')).toBeGreaterThan(constants.coverLetterLimitFor('BADGE'))
  })
  it('falls back to the middle limit for a tier it does not know, never to unlimited', () => {
    expect(constants.coverLetterLimitFor('SOMETHING_NEW')).toBe(3)
    expect(constants.coverLetterLimitFor(undefined)).toBe(3)
  })
})

describe('the scan the browser receives', () => {
  it('carries the count and the derived limit', () => {
    const scan = toClientScan(scanRowToCamel({ id: 's1', fix_tier: 'BADGE', cover_letter_count: 1 }))
    expect(scan.coverLetterCount).toBe(1)
    expect(scan.coverLetterLimit).toBe(2)
  })
  it('treats a row from before the migration as zero used', () => {
    const scan = toClientScan(scanRowToCamel({ id: 's1', fix_tier: 'FIX' }))
    expect(scan.coverLetterCount).toBe(0)
    expect(scan.coverLetterLimit).toBe(5)
  })
})

describe('generateCoverLetter — the limit', () => {
  it('claims a slot with the tier limit before calling the model, and reports the new count', async () => {
    t = setup({ tier: 'BADGE', claim: 2 })
    const res = await t.mod.generateCoverLetter(ctx())
    expect(res.status).toBe(200)
    expect(t.state.rpcs[0]).toEqual({ name: 'claim_cover_letter_slot', args: { p_scan_id: 's1', p_user_id: 'u1', p_max: 2 } })
    expect(res.body.data.coverLetterCount).toBe(2)
    expect(res.body.data.coverLetterLimit).toBe(2)
    expect(t.state.rpcs.some(r => r.name === 'release_cover_letter_slot')).toBe(false)
  })

  it('refuses with 409 and never calls the model when no slot is left', async () => {
    t = setup({ tier: 'FIX_PLAIN', claim: -1 })
    const res = await t.mod.generateCoverLetter(ctx())
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('COVER_LETTER_LIMIT')
    expect(res.body.coverLetterLimit).toBe(3)
    expect(res.body.message).toMatch(/all 3 cover letters/)
    expect(t.state.modelCalls).toBe(0)
    expect(t.state.rpcs.some(r => r.name === 'release_cover_letter_slot')).toBe(false)
  })

  it('gives the slot back when the model produces no letter', async () => {
    t = setup({ letter: { success: false, error: 'FABRICATION_DETECTED' } })
    const res = await t.mod.generateCoverLetter(ctx())
    expect(res.status).toBe(502)
    expect(t.state.rpcs.filter(r => r.name === 'release_cover_letter_slot')).toEqual([{ name: 'release_cover_letter_slot', args: { p_scan_id: 's1' } }])
  })

  it('gives the slot back when the model call throws, and still throws', async () => {
    t = setup({ throwModel: true })
    await expect(t.mod.generateCoverLetter(ctx())).rejects.toThrow('boom')
    expect(t.state.rpcs.filter(r => r.name === 'release_cover_letter_slot')).toHaveLength(1)
  })

  it('gives the slot back when the resume changed while the letter was being written', async () => {
    t = setup({ lostRace: true })
    const res = await t.mod.generateCoverLetter(ctx())
    expect(res.status).toBe(409)
    expect(res.body.code).toBeUndefined()
    expect(t.state.rpcs.filter(r => r.name === 'release_cover_letter_slot')).toHaveLength(1)
  })

  it('does not use a slot on a request that is refused for another reason', async () => {
    t = setup()
    const bad = ctx({ body: { tone: 'sarcastic' } })
    const res = await t.mod.generateCoverLetter(bad)
    expect(res.status).toBe(400)
    expect(t.state.rpcs).toEqual([])
  })

  it('allows the letter while the database predates migration 0104, and releases nothing if it then fails', async () => {
    t = setup({ claimError: { code: 'PGRST202', message: 'Could not find the function public.claim_cover_letter_slot' } })
    const ok = await t.mod.generateCoverLetter(ctx())
    expect(ok.status).toBe(200)
    expect(ok.body.data.coverLetterCount).toBeNull()
    t.restore()
    t = setup({ claimError: { code: '42883', message: 'function does not exist' }, letter: { success: false, error: 'X' } })
    expect((await t.mod.generateCoverLetter(ctx())).status).toBe(502)
    expect(t.state.rpcs.some(r => r.name === 'release_cover_letter_slot')).toBe(false)
  })

  it('does not swallow a real database error as "no limit"', async () => {
    t = setup({ claimError: { code: '57014', message: 'canceling statement due to statement timeout' } })
    await expect(t.mod.generateCoverLetter(ctx())).rejects.toBeTruthy()
    expect(t.state.modelCalls).toBe(0)
  })
})
