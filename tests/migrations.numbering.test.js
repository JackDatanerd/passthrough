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

describe('migrations', () => {
  it('every file is NNNN_name.sql', () => { for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/) })
  it('numbers are contiguous and unique (two files once shared 0076; `supabase db push` keys its history on the number)', () => {
    const nums = files.map(num)
    expect(new Set(nums).size, `duplicate migration number among ${nums.join(',')}`).toBe(nums.length)
    for (let i = 1; i < nums.length; i++) expect(nums[i], `gap after ${nums[i - 1]}`).toBe(nums[i - 1] + 1)
  })
  it('every migration from 0082 on records ITSELF in the applied_migrations ledger (schema_version alone cannot see a skipped one)', () => {
    for (const f of files.filter(f => num(f) >= 82)) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
      const name = f.replace(/\.sql$/, '')
      expect(sql, f).toMatch(new RegExp(`insert into applied_migrations[\\s\\S]{0,80}\\(\\s*${num(f)}\\s*,\\s*'${name}'\\s*\\)`, 'i'))
    }
  })
  // Audit A10: 0125 was renumbered from 0124 but kept recording itself as 124 (ledger row AND schema_version). The checks above only looked at
  // the NEWEST file's schema_version, so an older file with the wrong number went unseen until the ledger had a hole for 125.
  it('every migration from 0059 on writes ITS OWN number to schema_version, guards the upsert with the same number, and records the ledger row with on conflict do nothing', () => {
    const bad = []
    for (const f of files.filter(f => num(f) >= 59)) {
      const n = num(f), sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
      const versions = [...sql.matchAll(/'schema_version'[\s\S]{0,120}?'version',\s*(\d+)/gi)].map(m => Number(m[1]))
      const guards = [...sql.matchAll(/\)::int,\s*0\)\s*<\s*(\d+)/g)].map(m => Number(m[1]))
      if (versions.length !== 1 || versions[0] !== n) bad.push(`${f}: schema_version value ${JSON.stringify(versions)}`)
      if (guards.length !== 1 || guards[0] !== n) bad.push(`${f}: never-backwards guard ${JSON.stringify(guards)}`)
      if (n >= 82 && !/insert into applied_migrations[^;]*on conflict \(version\) do nothing;/i.test(sql)) bad.push(`${f}: ledger insert without on conflict (version) do nothing`)
    }
    expect(bad).toEqual([])
  })
  it('DEPLOYMENT.md has a migration-runbook row for every migration from 0119 on (apply order is written where the deployer looks)', () => {
    const doc = fs.readFileSync(path.join(dir, '..', '..', 'DEPLOYMENT.md'), 'utf8')
    const missing = files.filter(f => num(f) >= 119).filter(f => !new RegExp(`^#\\s*\\|\\s*${f.slice(0, 4)}\\s*\\|\\s*(before|Worker first)\\s*\\|`, 'm').test(doc)).map(f => f.slice(0, 4))
    expect(missing, 'add a "# | NNNN | before | what it is |" row to the MIGRATION RUNBOOK at the end of DEPLOYMENT.md').toEqual([])
  })
  it('LEDGER_NAMES (what /health compares recorded names against) lists exactly the migration files from 0082 on', async () => {
    const { LEDGER_NAMES } = (await import('../src/config/migrationLedger.js')).default ? (await import('../src/config/migrationLedger.js')).default : await import('../src/config/migrationLedger.js')
    const want = Object.fromEntries(files.filter(f => num(f) >= 82).map(f => [num(f), f.replace(/\.sql$/, '')]))
    expect(LEDGER_NAMES).toEqual(want)
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
