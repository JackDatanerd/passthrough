import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0118 (database layer round 6) against a real Postgres (PGlite). Every defect is reproduced on the schema as it stood BEFORE
// the migration, then the migration is applied and the same probes must come out right.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0118'))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const U1 = id(1), U2 = id(2), P1 = id(11), P2 = id(12), P3 = id(13), C1 = id(21), C2 = id(22), S1 = id(31), S2 = id(32), PAY = id(41), SALE = id(51)

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const before = {}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`
    insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'victim@example.com', 'h'), ('${U2}', 'V', 'v@x.co', 'h');
    insert into scans (id, user_id) values ('${S1}', '${U1}'), ('${S2}', '${U2}');
    insert into partners (id,name,email,dashboard_token) values ('${P1}','P1','p1@x.co','t1'), ('${P2}','P2','p2@x.co','t2'), ('${P3}','P3','p3@x.co','t3');
    insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','AAA','{"FIX":1900}'::jsonb), ('${C2}','${P2}','BBB','{"FIX":1900}'::jsonb);
    insert into payments (id, amount_cents, paystack_ref, user_id) values ('${PAY}', 1900, 'ref-1', '${U1}');
    insert into commission_ledger (id, payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents)
      values ('${SALE}', '${PAY}', '${P1}', '${C1}', 1900, 0.2, 380);
    insert into commission_ledger (partner_id, kind, gross_amount_cents, commission_rate, commission_amount_cents, adjusts_ledger_id, adjustment_reason)
      values ('${P1}', 'ADJUSTMENT', 0, 0, -100, '${SALE}', 'test');
    insert into partner_terms_acceptances (partner_id, version, source) values ('${P3}', 'v1', 'dashboard');
    insert into email_logs ("to", subject, template, status) values ('Victim@Example.com', 's', 't', 'sent');`)

  // The defects, on the schema as it was.
  before.partnerDelete = await db.exec(`delete from partners where id = '${P3}'`).then(() => 'ok', e => e.message)
  before.nullRound = (await q(`select grant_fix_credit_once($1, $2, null) a, grant_fix_credit_once($1, $2, null) b`, [S1, U1]))[0]
  before.reattribute = (await q(`select reattribute_sale($1, $2, $3, 0.2, 380) r`, [SALE, C2, P2]))[0].r
  await db.exec(`update commission_ledger set partner_id = '${P1}', referral_code_id = '${C1}' where id = '${SALE}'`)
  await db.exec(`select scrub_account_data('${U1}')`)
  before.mixedCaseLog = (await q(`select "to" from email_logs`))[0].to

  // Put the rows back for the after-state.
  await db.exec(`
    update users set email = 'victim@example.com', deleted_at = null, free_fix_credits = 0 where id = '${U1}';
    update scans set fix_credit_round = null where id = '${S1}';
    update email_logs set "to" = 'Victim@Example.com';
    insert into partner_terms_acceptances (partner_id, version, source) select '${P3}', 'v1', 'dashboard' where not exists (select 1 from partners where id = '${P3}') and false;`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0118: the defects were real', () => {
  it('a partner with a dashboard terms acceptance could not be deleted', () => { expect(before.partnerDelete).toMatch(/partner_terms_acceptances_check/) })
  it('a NULL round granted a credit every time', () => { expect([before.nullRound.a, before.nullRound.b]).toEqual([true, true]) })
  it('a sale with an adjustment could be moved to another partner', () => { expect(before.reattribute).toBe('ok') })
  it('mail logged with capitals survived the erase', () => { expect(before.mixedCaseLog).toBe('Victim@Example.com') })
})

describe('0118: terms acceptances and partner deletion', () => {
  it('deleting a partner drops its email-less acceptances and keeps (unlinked) the ones that carry an application email', async () => {
    await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${id(14)}','P4','p4@x.co','t4')`)
    await db.exec(`insert into partner_terms_acceptances (partner_id, version, source) values ('${id(14)}', 'v1', 'dashboard')`)
    await db.exec(`insert into partner_terms_acceptances (partner_id, application_email, version, source) values ('${id(14)}', 'a@x.co', 'v1', 'application')`)
    await db.exec(`delete from partners where id = '${id(14)}'`)
    const rows = await q(`select partner_id, application_email from partner_terms_acceptances where application_email = 'a@x.co' or partner_id = $1`, [id(14)])
    expect(rows).toEqual([{ partner_id: null, application_email: 'a@x.co' }])
  })
  it('the trigger function is not callable by anon or authenticated', async () => {
    const [{ a, b }] = await q(`select has_function_privilege('anon', 'partners_clear_unlinkable_terms()', 'execute') a, has_function_privilege('authenticated', 'partners_clear_unlinkable_terms()', 'execute') b`)
    expect([a, b]).toEqual([false, false])
  })
})

describe('0118: credit grants', () => {
  it('NULL arguments grant nothing', async () => {
    const [r] = await q(`select grant_fix_credit_once($1, $2, null) a, grant_fix_credit_once(null, $2, 1) b, grant_fix_credit_once($1, null, 1) c, grant_upgrade_credit_once(null, $2) d`, [S1, U1])
    expect(Object.values(r)).toEqual([false, false, false, false])
    expect((await q(`select free_fix_credits n from users where id = $1`, [U1]))[0].n).toBe(0)
  })
  it('a scan only credits the account that owns it', async () => {
    expect((await q(`select grant_fix_credit_once($1, $2, 1) g`, [S2, U1]))[0].g).toBe(false)
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S2, U1]))[0].g).toBe(false)
    expect((await q(`select free_fix_credits n from users where id = $1`, [U1]))[0].n).toBe(0)
  })
  it('still grants exactly once per round for the owner', async () => {
    expect((await q(`select grant_fix_credit_once($1, $2, 1) g`, [S1, U1]))[0].g).toBe(true)
    expect((await q(`select grant_fix_credit_once($1, $2, 1) g`, [S1, U1]))[0].g).toBe(false)
    expect((await q(`select grant_fix_credit_once($1, $2, 2) g`, [S1, U1]))[0].g).toBe(true)
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S1, U1]))[0].g).toBe(true)
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S1, U1]))[0].g).toBe(false)
    expect((await q(`select free_fix_credits n from users where id = $1`, [U1]))[0].n).toBe(3)
  })
  it('an erased account is not credited', async () => {
    await db.exec(`update users set deleted_at = now() where id = '${U2}'`)
    expect((await q(`select grant_fix_credit_once($1, $2, 1) g`, [S2, U2]))[0].g).toBe(false)
  })
})

describe('0118: reattribute_sale', () => {
  it('refuses a sale that has adjustments, and changes nothing', async () => {
    expect((await q(`select reattribute_sale($1, $2, $3, 0.2, 380) r`, [SALE, C2, P2]))[0].r).toBe('has_adjustments')
    expect((await q(`select partner_id from commission_ledger where id = $1`, [SALE]))[0].partner_id).toBe(P1)
  })
  it('still moves a sale that has none', async () => {
    await db.exec(`delete from commission_ledger where adjusts_ledger_id = '${SALE}'`)
    expect((await q(`select reattribute_sale($1, $2, $3, 0.2, 380) r`, [SALE, C2, P2]))[0].r).toBe('ok')
    expect((await q(`select partner_id from commission_ledger where id = $1`, [SALE]))[0].partner_id).toBe(P2)
  })
})

describe('0118: account erase', () => {
  it('matches the logged address whatever its case', async () => {
    await db.exec(`select scrub_account_data('${U1}')`)
    expect((await q(`select "to" from email_logs`))[0].to).toBe(`deleted-${U1}@passthrough.dev`)
  })
  it('has an index to do it with', async () => {
    expect((await q(`select 1 from pg_indexes where indexname = 'idx_email_logs_to_lower'`)).length).toBe(1)
  })
})

describe('0118: housekeeping', () => {
  it('indexes the four unindexed foreign keys', async () => {
    const r = await q(`select indexname from pg_indexes where indexname in ('idx_scans_fix_payment_id','idx_partner_applications_partner_id','idx_admin_audit_log_actor_id','idx_scan_outcomes_story_moderated_by')`)
    expect(r.length).toBe(4)
  })
  it('keeps every changed function closed to anon and authenticated', async () => {
    for (const sig of ['grant_fix_credit_once(uuid,uuid,int)', 'grant_upgrade_credit_once(uuid,uuid)', 'reattribute_sale(uuid,uuid,uuid,numeric,int)', 'scrub_account_data(uuid)']) {
      const [{ a, b, c }] = await q(`select has_function_privilege('anon', '${sig}', 'execute') a, has_function_privilege('authenticated', '${sig}', 'execute') b, has_function_privilege('service_role', '${sig}', 'execute') c`)
      expect([sig, a, b, c]).toEqual([sig, false, false, true])
    }
  })
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 118`))[0].name).toBe('0118_database_round6')
    expect((await q(`select value->>'version' v from system_state where key = 'schema_version'`))[0].v).toBe('118')
  })
})
