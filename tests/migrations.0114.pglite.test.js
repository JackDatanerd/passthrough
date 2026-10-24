import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migrations 0113 (PAYPAL payout method) and 0114 (sealed tax IDs) against a real Postgres (PGlite).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const P1 = '22222222-2222-2222-2222-222222222222'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','d1')`)
}, 180000)
afterAll(async () => { await db?.close() })

describe('0114: sealed tax IDs fit the check', () => {
  it('accepts a sealed value (up to 400 characters), a plain legacy ID, and null', async () => {
    const sealed = 'enc:v1:' + 'A'.repeat(16) + ':' + 'B'.repeat(260)
    await db.exec(`update partners set tax_id = '${sealed}' where id = '${P1}'`)
    expect((await q(`select tax_id from partners where id = '${P1}'`))[0].tax_id).toBe(sealed)
    await db.exec(`update partners set tax_id = 'A123456789B' where id = '${P1}'`)
    await db.exec(`update partners set tax_id = null where id = '${P1}'`)
  })
  it('still refuses too short a value and anything over 400 characters', async () => {
    await expect(db.exec(`update partners set tax_id = 'ab' where id = '${P1}'`)).rejects.toThrow()
    await expect(db.exec(`update partners set tax_id = '${'x'.repeat(401)}' where id = '${P1}'`)).rejects.toThrow()
  })
  it('is safe to run twice', async () => {
    await db.exec(read('0114_tax_id_sealed.sql'))
    expect((await q(`select value->>'version' v from system_state where key = 'schema_version'`))[0].v).toBe('114')
  })
})

describe('0113: PayPal is a payout method', () => {
  it('lets a partner be set to PAYPAL, and rejects an unknown method', async () => {
    await db.exec(`update partners set payout_method = 'PAYPAL' where id = '${P1}'`)
    expect((await q(`select payout_method from partners where id = '${P1}'`))[0].payout_method).toBe('PAYPAL')
    await expect(db.exec(`update partners set payout_method = 'VENMO' where id = '${P1}'`)).rejects.toThrow()
  })
})

describe('the ledger', () => {
  it('records both migrations and the schema version is the newest', async () => {
    const rows = await q(`select version, name from applied_migrations where version in (113, 114) order by version`)
    expect(rows).toEqual([{ version: 113, name: '0113_payout_method_paypal' }, { version: 114, name: '0114_tax_id_sealed' }])
  })
})
