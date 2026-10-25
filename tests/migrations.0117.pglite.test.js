import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0117 (partners round 40) against a real Postgres (PGlite): renaming a referral code moves the code, the buyers that carry
// it and the payments that carry it in ONE transaction.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0117'))
const U1 = '55555555-5555-5555-5555-555555555555', P1 = '66666666-6666-6666-6666-666666666661'
const C1 = '77777777-7777-7777-7777-777777777771', C2 = '77777777-7777-7777-7777-777777777772'

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
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash, referred_by_code) values ('${U1}', 'U', 'u@x.co', 'h', 'ANN10')`)
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','legacy-token')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{"FIX":1900}'::jsonb), ('${C2}','${P1}','TAKEN','{"FIX":1900}'::jsonb)`)
  await db.exec(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_code) values (1900, 'ref-a', '${U1}', '${C1}', 'ANN10')`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0117: rename_referral_code', () => {
  it('moves the code, the buyers and the payments together and returns the old text', async () => {
    const [{ rename_referral_code: old }] = await q(`select rename_referral_code($1, 'ANN20')`, [C1])
    expect(old).toBe('ANN10')
    expect((await q(`select code from referral_codes where id = $1`, [C1]))[0].code).toBe('ANN20')
    expect((await q(`select referred_by_code r from users where id = $1`, [U1]))[0].r).toBe('ANN20')
    expect((await q(`select referral_code r from payments where referral_code_id = $1`, [C1]))[0].r).toBe('ANN20')
  })
  it('a taken text changes nothing at all', async () => {
    await expect(q(`select rename_referral_code($1, 'TAKEN')`, [C1])).rejects.toThrow()
    expect((await q(`select code from referral_codes where id = $1`, [C1]))[0].code).toBe('ANN20')
    expect((await q(`select referred_by_code r from users where id = $1`, [U1]))[0].r).toBe('ANN20')
  })
  it('an unknown code is P0002', async () => {
    await expect(q(`select rename_referral_code('00000000-0000-4000-8000-0000000000ff', 'ZZ')`)).rejects.toMatchObject({ code: 'P0002' })
  })
  it('is not callable by anon or authenticated', async () => {
    const [{ a, b }] = await q(`select has_function_privilege('anon', 'rename_referral_code(uuid,text)', 'execute') a, has_function_privilege('authenticated', 'rename_referral_code(uuid,text)', 'execute') b`)
    expect([a, b]).toEqual([false, false])
  })
})
