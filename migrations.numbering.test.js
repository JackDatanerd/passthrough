import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import constants from '../src/config/constants.js'

// Database layer audit: migration hygiene. Two parallel sessions once both wrote 0076; the schema_version check is a
// single integer so it cannot tell that one of them is missing. This keeps it from happening again.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const num = f => parseInt(f.slice(0, 4), 10)
const KNOWN_DUPLICATES = new Set([76]) // 0076_employer_leads_round12 + 0076_profile_dashboard_round11 (both already applied; renaming would break path references)

describe('migrations', () => {
  it('every file is NNNN_name.sql', () => { for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/) })
  it('numbers are contiguous and unique, apart from the known 0076 pair', () => {
    const seen = new Map()
    for (const f of files) seen.set(num(f), (seen.get(num(f)) || 0) + 1)
    for (const [n, c] of seen) if (c > 1) expect(KNOWN_DUPLICATES.has(n), `duplicate migration number ${n}`).toBe(true)
    const nums = [...seen.keys()]
    for (let i = 1; i < nums.length; i++) expect(nums[i], `gap after ${nums[i - 1]}`).toBe(nums[i - 1] + 1)
  })
  it('EXPECTED_SCHEMA_VERSION equals the newest migration number', () => {
    expect(constants.EXPECTED_SCHEMA_VERSION).toBe(num(files[files.length - 1]))
  })
  it('the newest migration records its own schema_version', () => {
    const last = files[files.length - 1]
    expect(fs.readFileSync(path.join(dir, last), 'utf8')).toMatch(new RegExp(`schema_version[\\s\\S]{0,80}'?${num(last)}'?`))
  })
  it('dropped columns (0077) are no longer referenced by src', () => {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
    const src = path.join(dir, '..', '..', 'src')
    for (const f of walk(src).filter(f => f.endsWith('.js'))) {
      const t = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(t, f).not.toMatch(/paystack_customer_code|paystack_auth_code|integrity_score/)
    }
  })
})
