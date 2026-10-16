import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0093 (partners section 4 round 16) against a real Postgres (PGlite): channel-tag columns with their format CHECKs,
// and the scrub that takes referral-code text out of the append-only audit log (leaving the log append-only afterwards).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0093_partners_section4_round16.sql'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const rejects = sql => expect(db.exec(sql)).rejects.toThrow()
const P1 = '22222222-2222-2222-2222-222222222222'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  // audit rows as the OLD code wrote them (the code text in `detail`)
  await db.exec(`insert into admin_audit_log (action, target_type, target_id, detail) values
    ('partner.referral_code_created','referral_code','code-id-1','{"partnerId":"p","code":"ANNA20","usageLimit":5}'),
    ('partner.referral_code_updated','referral_code','code-id-1','{"partnerId":"p","code":"ANNA20","changed":["active"]}'),
    ('partner.referral_code_updated','referral_code','code-id-2','{"partnerId":"p","codeId":"code-id-2","changed":["active"]}'),
    ('partner.update','partner','p','{"code":"KEEP-ME"}')`)
  for (const f of files.filter(f => f >= MIG)) await db.exec(read(f))
}, 180000)
afterAll(async () => { await db?.close() })

describe('0093: audit log scrub', () => {
  it('replaces the code text with the code row id, keeping every other field', async () => {
    const rows = await q(`select target_id, detail from admin_audit_log where action like 'partner.referral_code_%' order by target_id, action`)
    expect(JSON.stringify(rows)).not.toContain('ANNA20')
    const created = rows.find(r => r.detail.usageLimit === 5)
    expect(created.detail).toEqual({ partnerId: 'p', codeId: 'code-id-1', usageLimit: 5 })
    expect(rows.find(r => r.detail.codeId === 'code-id-2').detail).toEqual({ partnerId: 'p', codeId: 'code-id-2', changed: ['active'] })
  })
  it('touches no other action', async () => {
    expect((await q(`select detail from admin_audit_log where action='partner.update'`))[0].detail).toEqual({ code: 'KEEP-ME' })
  })
  it('leaves the log append-only afterwards', async () => {
    await rejects(`update admin_audit_log set action = 'x' where action = 'partner.update'`)
    await rejects(`delete from admin_audit_log where action = 'partner.update'`)
    expect((await q(`select tgenabled from pg_trigger where tgname = 'admin_audit_log_append_only_trg'`))[0].tgenabled).toBe('O')
  })
  it('is safe to run again', async () => {
    await db.exec(read(MIG))
    expect((await q(`select count(*)::int n from admin_audit_log where detail ? 'code'`))[0].n).toBe(1)   // only the partner.update row
  })
})

describe('0093: channel tag columns', () => {
  it('exist and default to null', async () => {
    const cols = await q(`select table_name, column_name from information_schema.columns where column_name in ('referral_sub','attribution_sub') order by 1`)
    expect(cols).toEqual([{ table_name: 'commission_ledger', column_name: 'attribution_sub' }, { table_name: 'payments', column_name: 'referral_sub' }])
  })
  it('accept 1-32 of a-z 0-9 _ - and refuse anything else', async () => {
    await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','dash1')`)
    const ins = tag => `insert into commission_ledger (partner_id, kind, adjustment_reason, commission_amount_cents, gross_amount_cents, commission_rate, attribution_sub)
                        values ('${P1}','ADJUSTMENT','t',1,1,0,${tag})`
    for (const ok of ["'news-letter_1'", "'a'", `'${'a'.repeat(32)}'`, 'null']) await db.exec(ins(ok))
    for (const bad of ["''", "'UPPER'", "'two words'", `'${'a'.repeat(33)}'`, "'x@y'"]) await rejects(ins(bad))
  })
})
