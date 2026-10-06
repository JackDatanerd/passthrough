import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// supabase/seed.js used to create an ADMIN account with a password that sat in this PUBLIC
// repository, and DEPLOYMENT.md told you to run it against production.
const script = fileURLToPath(new URL('../supabase/seed.js', import.meta.url))
const run = env => spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })

describe('supabase/seed.js safety', () => {
  it('refuses to run without an explicit SEED_ENV=development', () => {
    const r = run({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/Refusing to seed/)
  })
  it('refuses when NODE_ENV is production even with the opt-in', () => {
    const r = run({ SEED_ENV: 'development', NODE_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' })
    expect(r.status).toBe(1)
  })
  it('needs credentials even with the opt-in', () => {
    const r = run({ SEED_ENV: 'development' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/SUPABASE_URL/)
  })
  it('contains no hard-coded password', () => {
    const src = readFileSync(script, 'utf8')
    expect(src).not.toMatch(/Passthrough2024/)
    expect(src).not.toMatch(/password:\s*'[^']+'/)
  })
})
