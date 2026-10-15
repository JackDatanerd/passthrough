import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import rl from '../src/middleware/rateLimiter.js'
import { validateEnv } from '../src/lib/env.js'
import { computeHealth } from '../src/lib/health.js'
import constants from '../src/config/constants.js'

// Cross-cutting infra round 10.
const here = path.dirname(fileURLToPath(import.meta.url))

describe('BROWSER binding is a required binding (bug)', () => {
  const okDo = { idFromName: k => k, get: () => ({ fetch: async () => new Response(JSON.stringify({ limited: false }), { status: 200 }) }) }
  const base = { SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 'k', JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'production',
    RATE_LIMIT_DO: okDo, RESUMES_BUCKET: {}, FIX_QUEUE: {} }
  const sb = {
    from: t => ({ select: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: t === 'system_state' ? { value: { version: constants.EXPECTED_SCHEMA_VERSION, at: new Date().toISOString() }, updated_at: 't' } : null, error: null }) }),
      gte: () => ({ limit: async () => ({ data: [], error: null }), then: r => r({ data: Array.from({ length: constants.EXPECTED_SCHEMA_VERSION - 81 }, (_, i) => ({ version: 82 + i })), error: null }) }),
      limit: async () => ({ data: [], error: null }),
    }) }),
  }
  it('validateEnv warns when BROWSER is missing and is quiet when it is bound', () => {
    expect(validateEnv(base).warnings.join('\n')).toMatch(/binding BROWSER is missing/)
    expect(validateEnv({ ...base, BROWSER: {} }).warnings.join('\n')).not.toMatch(/binding BROWSER/)
  })
  it('the deep health check reports a missing BROWSER binding as a problem', async () => {
    const h = await computeHealth(base, sb)
    expect(h.ok).toBe(false)
    expect(h.problems.join(' ')).toMatch(/binding is missing/)
    const good = await computeHealth({ ...base, BROWSER: {} }, sb)
    expect(good.problems.join(' ')).not.toMatch(/binding is missing/)
  })
})

describe('cover-letter download has its own limiter bucket (bug)', () => {
  it('exports coverLetterDownload and scan.routes wires it, not draftDownload, to GET /:id/cover-letter', () => {
    expect(typeof rl.coverLetterDownload).toBe('function')
    const src = fs.readFileSync(path.join(here, '../src/routes/scan.routes.js'), 'utf8')
    const line = src.split('\n').find(l => /router\.get\(\s*'\/:id\/cover-letter'/.test(l))
    expect(line).toMatch(/rl\.coverLetterDownload/)
    expect(line).not.toMatch(/rl\.draftDownload/)
  })
})
