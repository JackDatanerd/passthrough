import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0105, on a REAL Postgres (PGlite): the system partner that owns welcome codes, the per-account code column, and
// the rules that make a code personal. The migrations are applied in order, as in migrations.pglite.test.js.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const SYSTEM_PARTNER = '00000000-0000-4000-8000-00000000e1c0'          // constants.WELCOME_PARTNER_ID

let db
const failures = []
const rows = async (sql, params) => (await db.query(sql, params)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
    try { await db.exec(sql) } catch (e) { failures.push(`${f}: ${e.message}`) }
  }
}, 120000)

const newUser = async email => (await rows(`insert into users (email, name, password_hash) values ($1, 'Test', 'x') returning id`, [email]))[0].id
const insertCode = (code, userId, over = {}) => db.query(
  `insert into referral_codes (partner_id, code, tier_prices, active, usage_limit, expires_at, user_id)
   values ($1, $2, $3::jsonb, true, 1, now() + interval '14 days', $4)`,
  [over.partner ?? SYSTEM_PARTNER, code, JSON.stringify(over.tiers ?? { FIX: 2030 }), userId])

describe('migration 0105', () => {
  it('applies, with every migration before and after it', () => {
    expect(failures).toEqual([])
  })

  it('records itself and moves the schema version to at least 105', async () => {
    expect((await rows(`select name from applied_migrations where version = 105`))[0]?.name).toBe('0105_welcome_codes')
    const v = (await rows(`select value from system_state where key = 'schema_version'`))[0].value
    expect(Number(v.version)).toBeGreaterThanOrEqual(105)
  })

  it('creates the system partner: active, 0% commission, no conversion mail, never able to be paid out', async () => {
    const [p] = await rows(`select * from partners where id = $1`, [SYSTEM_PARTNER])
    expect(p).toBeTruthy()
    expect(p.status).toBe('ACTIVE')
    expect(Number(p.commission_rate)).toBe(0)
    expect(p.notify_conversions).toBe(false)
    expect(p.email).toMatch(/@system\.invalid$/)
    expect(p.payout_details_token).toBeNull()
    expect(p.payout_details).toBeNull()
    expect(String(p.dashboard_token).length).toBeGreaterThanOrEqual(64)
    expect(p.internal_notes).toMatch(/Do not edit, pause or delete/)
  })

  it('does not look like an erased partner, whose mail and codes are refused', async () => {
    const [p] = await rows(`select email from partners where id = $1`, [SYSTEM_PARTNER])
    expect(p.email.endsWith('@removed.invalid')).toBe(false)
  })

  it('is safe to apply twice (the partner is not duplicated)', async () => {
    const sql = fs.readFileSync(path.join(dir, '0105_welcome_codes.sql'), 'utf8')
    await db.exec(sql)
    expect((await rows(`select count(*)::int n from partners where id = $1`, [SYSTEM_PARTNER]))[0].n).toBe(1)
    const v = (await rows(`select value from system_state where key = 'schema_version'`))[0].value
    expect(Number(v.version)).toBeGreaterThanOrEqual(105)
  })

  it('stores a welcome code the way the Worker writes it (fixed cents, one use, an owner)', async () => {
    const uid = await newUser('a@example.com')
    await insertCode('AN-7K2QH', uid)
    const [r] = await rows(`select * from referral_codes where code = 'AN-7K2QH'`)
    expect(r.user_id).toBe(uid)
    expect(r.partner_id).toBe(SYSTEM_PARTNER)
    expect(r.tier_prices).toEqual({ FIX: 2030 })
    expect(r.usage_limit).toBe(1)
  })

  it('allows only ONE code per account', async () => {
    const uid = await newUser('b@example.com')
    await insertCode('BB-AAAAA', uid)
    await expect(insertCode('BB-BBBBB', uid)).rejects.toThrow(/referral_codes_one_per_user_uidx|duplicate key/)
  })

  it('still allows any number of ordinary partner codes (no owner)', async () => {
    await db.query(`insert into partners (name, email, dashboard_token) values ('P', 'p@example.com', 'tok-1')`)
    const [{ id }] = await rows(`select id from partners where email = 'p@example.com'`)
    for (const code of ['PARTNER10', 'PARTNER20', 'PARTNER30']) await insertCode(code, null, { partner: id, tiers: { FIX: 2500 } })
    expect((await rows(`select count(*)::int n from referral_codes where partner_id = $1`, [id]))[0].n).toBe(3)
  })

  it('refuses a code for an account that does not exist', async () => {
    await expect(insertCode('GH-AAAAA', '11111111-1111-4111-8111-111111111111')).rejects.toThrow(/foreign key|violates/)
  })

  it('keeps the existing rules on codes: stored in capitals, tier prices valid', async () => {
    const uid = await newUser('c@example.com')
    await expect(insertCode('lower-case', uid)).rejects.toThrow(/referral_codes_code_upper_chk|check constraint/)
    await expect(insertCode('CC-AAAAA', uid, { tiers: { FIX: -5 } })).rejects.toThrow(/referral_codes_tier_prices_chk|check constraint/)
  })

  it('records a 0-commission conversion against the system partner, and the code row can be spent', async () => {
    const uid = await newUser('d@example.com')
    await insertCode('DD-AAAAA', uid)
    const [code] = await rows(`select id from referral_codes where code = 'DD-AAAAA'`)
    const [scan] = await rows(`insert into scans (user_id) values ($1) returning id`, [uid])
    const [pay] = await rows(`insert into payments (user_id, scan_id, amount_cents, paystack_ref, referral_code_id) values ($1, $2, 2030, 'ref-welcome-1', $3) returning id`, [uid, scan.id, code.id])
    await db.query(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents)
                    values ($1, $2, $3, 2030, 0, 0)`, [pay.id, SYSTEM_PARTNER, code.id])
    const [l] = await rows(`select commission_rate, commission_amount_cents from commission_ledger where partner_id = $1`, [SYSTEM_PARTNER])
    expect(Number(l.commission_rate)).toBe(0)
    expect(l.commission_amount_cents).toBe(0)
    // the code is single-use: counting the one use is accepted, and the row stays tied to its owner
    await db.query(`update referral_codes set uses_so_far = 1 where id = $1`, [code.id])
    expect((await rows(`select user_id, uses_so_far from referral_codes where id = $1`, [code.id]))[0]).toEqual({ user_id: uid, uses_so_far: 1 })
  })
})
