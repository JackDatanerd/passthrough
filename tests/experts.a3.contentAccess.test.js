import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Experts audit A3 (content access). Regression tests: each fails on the code before migration 0128 / the A3 library fixes.
const require = createRequire(import.meta.url)
const locks = require('../src/lib/humanLocks')
const fieldCrypto = require('../src/lib/fieldCrypto')
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const U1 = '00000000-0000-4000-8000-000000000001', E1 = '00000000-0000-4000-8000-0000000000e1', E2 = '00000000-0000-4000-8000-0000000000e2', E3 = '00000000-0000-4000-8000-0000000000e3'

let db, n = 0
const q = async (s, p) => (await db.query(s, p)).rows
const one = async (s, p) => (await q(s, p))[0].r
async function job(state, over = {}) {
  n++
  const pid = `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`, jid = `00000000-0000-4000-8000-${String(2000 + n).padStart(12, '0')}`
  await db.query(`insert into payments (id, amount_cents, paystack_ref, user_id, status, product_kind) values ($1,11900,$2,$3,'SUCCESS','human_forty_eight_hour')`, [pid, `a3-${n}`, U1])
  await db.query(`insert into human_jobs (id, job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested, expert_id, delivered_at, brief, add_cover_letter)
    values ($1,$2,$3,$4,'forty_eight_hour',11900,11900,7000,$5,now(),true,true,$6,$7,$8,$9)`,
    [jid, `HJ-A3-${n}`, pid, U1, state, over.expert ?? null, over.delivered ?? null, JSON.stringify(over.brief ?? { targetRole: 'PM for Jane Doe', region: 'US', notes: 'call 0712345678' }), !!over.cover])
  await db.query(`insert into job_documents (job_id, kind, version, body, cover_letter) values ($1,'source',1,'{"a":1}',null), ($1,'working',1,'{"a":1}',$2)`, [jid, over.cover ? JSON.stringify({ text: 'Dear [[c:1]]' }) : null])
  return jid
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}','U','customer@example.com','h')`)
  for (const [id, em] of [[E1, 'e1@x.com'], [E2, 'e2@x.com'], [E3, 'customer@example.com']])
    await db.query(`insert into expert_accounts (id,email,password_hash,display_first_name,display_initial,status,enabled,totp_enabled_at,agreement_signed_at,agreement_version) values ($1,$2,'h','Ex','P','active',true,now(),now(),'v1')`, [id, em])
}, 300000)

describe('A3 database gate: nothing but a clear yes grants', () => {
  it('a NULL expert is refused (it used to read the whole job) and the attempt is logged', async () => {
    const j = await job('in_progress', { expert: E1 })
    expect(await one(`select human_job_expert_read($1, null) as r`, [j])).toBeNull()
    expect((await q(`select 1 from expert_audit_log where target_id = $1 and action = 'denied_job_access' and actor_id is null`, [j])).length).toBe(1)
    expect(await one(`select human_job_expert_read($1, $2) as r`, [j, E1])).not.toBeNull()
    expect(await one(`select human_job_expert_read($1, $2) as r`, [j, E2])).toBeNull()
  })
  it('a NULL window means the default 7 days, never "for ever"', async () => {
    const old = await job('delivered', { expert: E1, delivered: '2020-01-01' })
    expect(await one(`select human_job_expert_read($1, $2, null) as r`, [old, E1])).toBeNull()
    const fresh = await job('delivered', { expert: E1, delivered: new Date().toISOString() })
    expect(await one(`select human_job_expert_read($1, $2, null) as r`, [fresh, E1])).not.toBeNull()
  })
  it('save: a NULL base version, a NULL expert or a non-object body write nothing', async () => {
    const j = await job('in_progress', { expert: E1 })
    expect(await one(`select human_job_expert_save($1,$2,null,'{"a":9}'::jsonb,null,5) as r`, [j, E1])).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await one(`select human_job_expert_save($1,null,1,'{"a":9}'::jsonb,null,5) as r`, [j])).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(await one(`select human_job_expert_save($1,$2,1,'[1]'::jsonb,null,5) as r`, [j, E1])).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(await one(`select human_job_expert_save($1,$2,0,'{"a":9}'::jsonb,null,5) as r`, [j, E1])).toMatchObject({ ok: false, reason: 'conflict', current_version: 1 })
    expect((await q(`select count(*)::int as c from job_documents where job_id = $1 and kind = 'working'`, [j]))[0].c).toBe(1)
    expect(await one(`select human_job_expert_save($1,$2,1,'{"a":2}'::jsonb,null,5) as r`, [j, E1])).toMatchObject({ ok: true, version: 2 })
  })
  it('baseline refuses a NULL expert', async () => {
    const j = await job('in_progress', { expert: E1 })
    expect(await one(`select human_job_expert_baseline($1, null) as r`, [j])).toBeNull()
  })
})

describe('A3 cover letter follows add_cover_letter', () => {
  it('a save that leaves the letter out keeps the paid-for letter', async () => {
    const j = await job('in_progress', { expert: E1, cover: true })
    expect(await one(`select human_job_expert_save($1,$2,1,'{"a":2}'::jsonb,null,5) as r`, [j, E1])).toMatchObject({ ok: true })
    expect((await q(`select cover_letter from job_documents where job_id = $1 and kind = 'working' and version = 2`, [j]))[0].cover_letter).toEqual({ text: 'Dear [[c:1]]' })
    expect(await one(`select human_job_expert_save($1,$2,2,'{"a":3}'::jsonb,'{"text":"Hi [[c:1]]"}'::jsonb,5) as r`, [j, E1])).toMatchObject({ ok: true })
    expect((await q(`select cover_letter from job_documents where job_id = $1 and kind = 'working' and version = 3`, [j]))[0].cover_letter).toEqual({ text: 'Hi [[c:1]]' })
  })
  it('a job that bought no letter never gets one', async () => {
    const j = await job('in_progress', { expert: E1 })
    await db.query(`select human_job_expert_save($1,$2,1,'{"a":2}'::jsonb,'{"text":"free letter"}'::jsonb,5)`, [j, E1])
    expect((await q(`select cover_letter from job_documents where job_id = $1 and kind = 'working' and version = 2`, [j]))[0].cover_letter).toBeNull()
  })
})

describe('A3 assignment and unassignment', () => {
  it('unassigning from waiting_customer closes the question, folds the wait into the deadlines and frees the next expert', async () => {
    const j = await job('in_progress', { expert: E1 })
    await db.query(`update human_jobs set promised_deadline_at = '2030-01-02T00:00:00Z', internal_deadline_at = '2030-01-01T00:00:00Z' where id = $1`, [j])
    await db.query(`select human_job_ask($1,$2,'a question here',null,24,3)`, [j, E1])
    await db.query(`update human_jobs set pause_started_at = now() - interval '2 hours' where id = $1`, [j])
    expect(await one(`select human_job_unassign($1,null,'x') as r`, [j])).toMatchObject({ ok: true })
    const row = (await q(`select state, expert_id, pause_started_at, paused_seconds, promised_deadline_at, internal_deadline_at from human_jobs where id = $1`, [j]))[0]
    expect(row.state).toBe('offered'); expect(row.expert_id).toBeNull(); expect(row.pause_started_at).toBeNull()
    expect(row.paused_seconds).toBeGreaterThanOrEqual(7199); expect(row.paused_seconds).toBeLessThan(7300)
    expect(new Date(row.promised_deadline_at).getTime() - new Date('2030-01-02T00:00:00Z').getTime()).toBeGreaterThanOrEqual(7199e3)
    expect((await q(`select status from job_questions where job_id = $1`, [j]))[0].status).toBe('expired')
    expect(await one(`select human_job_assign($1,$2,null,2) as r`, [j, E2])).toMatchObject({ ok: true })
  })
  it('unassigning while working keeps the deadlines as they were', async () => {
    const j = await job('in_progress', { expert: E1 })
    await db.query(`update human_jobs set promised_deadline_at = '2030-01-02T00:00:00Z' where id = $1`, [j])
    await db.query(`select human_job_unassign($1,null,null)`, [j])
    expect((await q(`select promised_deadline_at = '2030-01-02T00:00:00Z' as same, paused_seconds from human_jobs where id = $1`, [j]))[0]).toEqual({ same: true, paused_seconds: 0 })
  })
  it('an expert cannot be given their own order (same email as the customer)', async () => {
    const j = await job('offered')
    expect(await one(`select human_job_assign($1,$2,null,2) as r`, [j, E3])).toMatchObject({ ok: false, reason: 'conflict_of_interest' })
    expect((await q(`select state from human_jobs where id = $1`, [j]))[0].state).toBe('offered')
    expect(await one(`select human_job_assign($1,$2,null,100) as r`, [j, E1])).toMatchObject({ ok: true })
  })
})

describe('A3 masking library', () => {
  it('masks names with accents, other scripts and two letters, anywhere in the text', () => {
    for (const name of ['José García', 'Zoë Müller', 'Étienne Dupré', 'Ngũgĩ Mwangi', 'Li Wu', 'Jo Ng', "Seán O’Brien"]) {
      const first = name.split(' ')[0], last = name.split(' ')[1]
      const { body } = locks.lockDocument({ name, summary: `${first} led the team; ask ${last} about it.` })
      expect(body.summary, name).not.toContain(first); expect(body.summary, name).not.toContain(last)
    }
  })
  it('does not blank ordinary two-letter words for a short name', () => {
    const { body } = locks.lockDocument({ name: 'An Do', summary: 'an engineer who can do it' })
    expect(body.summary).toBe('an engineer who can do it')
  })
  it('lifts web addresses with common endings, including country second levels', () => {
    for (const s of ['janedoe.io', 'me.tech', 'x.xyz', 'foo.github.io', 'bar.ca', 'a.edu', 'site.info', 'janedoe.co.ke', 'https://anything.example/page', 'janedoe.io/work'])
      expect(locks.contactSpans(`see ${s} now`).map(x => x.text), s).toEqual([s])
    expect(locks.contactSpans('Built with Node.js and Vue.js').length).toBe(0)
  })
})

describe('A3 locked-value storage', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64'), OTHER = Buffer.alloc(32, 9).toString('base64')
  it('an unreadable sealed value throws instead of reading as a blank', async () => {
    const sealed = await fieldCrypto.sealTaxId({ TAX_ID_ENCRYPTION_KEY: KEY }, 'jane@example.com')
    expect(await fieldCrypto.openSealedStrict({ TAX_ID_ENCRYPTION_KEY: KEY }, sealed)).toBe('jane@example.com')
    expect(await fieldCrypto.openSealedStrict({}, 'plain value')).toBe('plain value')
    for (const env of [{}, { TAX_ID_ENCRYPTION_KEY: OTHER }]) await expect(fieldCrypto.openSealedStrict(env, sealed)).rejects.toMatchObject({ code: 'LOCKED_VALUE_UNREADABLE' })
    await expect(fieldCrypto.openSealedStrict({ TAX_ID_ENCRYPTION_KEY: KEY }, 'enc:v9:x:y')).rejects.toMatchObject({ code: 'LOCKED_VALUE_UNREADABLE' })
    await expect(fieldCrypto.openSealedStrict({ TAX_ID_ENCRYPTION_KEY: KEY }, '')).rejects.toMatchObject({ code: 'LOCKED_VALUE_UNREADABLE' })
  })
  it('hasKey is async, so no caller may use it without await', () => {
    for (const f of ['src/controllers/human.controller.js', 'src/controllers/human-files.controller.js', 'src/services/humanDelivery.service.js']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      expect(src.match(/(?<!await\s)(?<!await \()fieldCrypto\.hasKey\(/g) || [], f).toEqual([])
    }
  })
})
