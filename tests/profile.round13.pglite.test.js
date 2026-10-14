import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Profile & Dashboard (Section 6), round 13 — migration 0084 against a REAL Postgres (PGlite), because the thing
// being fixed is what the SQL functions do, which a faked database cannot say.
//   B1: add_saved_profile took no edit marker, so "Copy as another profile" produced an unedited-looking copy; made
//       main, a later save from a scan replaced the hand corrections without the PROFILE_EDITED confirmation.
//   B2: set_saved_profile_resume / update_saved_profile stamped the marker on a save that changed nothing.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
let db
const failures = []
const q = async (sql, params) => (await db.query(sql, params)).rows
const U = '55555555-5555-4555-8555-555555555555'
const rd = (n, extra = {}) => ({ name: n, skills: [n], ...extra })
const prof = (n) => ({ resumeData: rd(n), savedAt: new Date().toISOString(), sourceScanId: null, roleCategory: 'software_engineering' })
const mainRow = async () => (await q(`select saved_profile sp, saved_profile_prev pv from users where id = $1`, [U]))[0]
const versionOf = async () => (await q(`select (saved_profile ->> 'savedAt') || '|' || coalesce(saved_profile ->> 'editedAt', '') v from users where id = $1`, [U]))[0].v
const edit = async (resume, version) => (await q(`select set_saved_profile_resume($1, $2, $3, $4) r`, [U, resume, new Date().toISOString(), version ?? null]))[0].r
const addExtra = async (label, resume, edited) => (await q(`select add_saved_profile($1, $2, $3, 'software_engineering', null, 4, $4) r`, [U, label, resume, edited ?? null]))[0].r

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;`)
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
    try { await db.exec(sql) } catch (e) { failures.push(`${f}: ${e.message}`) }
  }
  await db.exec(`insert into users (id, email, password_hash, name) values ('${U}', 'r13@example.com', 'x', 'R13')`)
}, 180000)
afterAll(async () => { await db?.close() })

describe('migration 0084 applies', () => {
  it('cleanly, with the rest', () => { expect(failures).toEqual([]) })
  it('leaves exactly one add_saved_profile (two overloads would make a named-argument call ambiguous)', async () => {
    expect(await q(`select 1 from pg_proc where proname = 'add_saved_profile'`)).toHaveLength(1)
  })
  it('the old six-argument call (the previous Worker) still resolves', async () => {
    const [{ r }] = await q(`select add_saved_profile(p_user_id => $1, p_label => 'Legacy call', p_resume => $2, p_role_category => 'x', p_source_scan_id => null, p_max => 4) r`, [U, rd('L')])
    expect(r).toMatch(/^[0-9a-f-]{36}$/)
    await q(`delete from saved_profiles where user_id = $1`, [U])
  })
  it('is not callable by the API roles', async () => {
    const [{ anon, authed }] = await q(`select has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') authed from pg_proc p where proname = 'add_saved_profile'`)
    expect([anon, authed]).toEqual([false, false])
  })
})

describe('B1: a copy carries the hand-edit marker', () => {
  it('add_saved_profile stores the marker it is given, and none by default', async () => {
    await q(`delete from saved_profiles where user_id = $1`, [U])
    const stamp = '2026-10-13T10:00:00.5+00:00'
    const a = await addExtra('Edited copy', rd('A'), stamp)
    const b = await addExtra('Plain', rd('B'))
    const rows = Object.fromEntries((await q(`select id, edited_at from saved_profiles where user_id = $1`, [U])).map(r => [r.id, r.edited_at]))
    expect(new Date(rows[a]).toISOString()).toBe('2026-10-13T10:00:00.500Z')
    expect(rows[b]).toBeNull()
  })
  it('copy of a hand-edited main profile, made main, still makes a save from a scan ask first', async () => {
    await q(`update users set saved_profile = null, saved_profile_prev = null where id = $1`, [U])
    await q(`delete from saved_profiles where user_id = $1`, [U])
    await q(`select save_profile_from_scan($1, $2, false)`, [U, prof('A')])
    expect(await edit(rd('A-corrected'))).toBe(true)
    const { sp } = await mainRow()
    expect(sp.editedAt).toBeTruthy()
    // What duplicatePrimary does: copy the resume AND the marker.
    const copy = await addExtra('Copy', sp.resumeData, sp.editedAt)
    expect((await q(`select promote_saved_profile($1, $2) r`, [U, copy]))[0].r).toBe('ok')
    expect((await mainRow()).sp.editedAt).toBeTruthy()
    // Not replaced without the person's say-so …
    expect((await q(`select save_profile_from_scan($1, $2, false) r`, [U, prof('C')]))[0].r).toBe(false)
    expect((await mainRow()).sp.resumeData.name).toBe('A-corrected')
    // … and replaced when they agree.
    expect((await q(`select save_profile_from_scan($1, $2, true) r`, [U, prof('C')]))[0].r).toBe(true)
  })
})

describe('B2: saving what is already stored is not an edit', () => {
  const fresh = async () => {
    await q(`update users set saved_profile = null, saved_profile_prev = null where id = $1`, [U])
    await q(`delete from saved_profiles where user_id = $1`, [U])
    await q(`select save_profile_from_scan($1, $2, false)`, [U, prof('A')])
  }
  it('main profile: nothing is stamped, snapshotted or re-versioned', async () => {
    await fresh()
    const before = await mainRow(); const v = await versionOf()
    expect(await edit(before.sp.resumeData, v)).toBe(true)         // reported as saved
    const after = await mainRow()
    expect(after.sp.editedAt).toBeUndefined()
    expect(after.pv).toBeNull()
    expect(await versionOf()).toBe(v)
    // …so a save from a scan is not held up by an edit nobody made.
    expect((await q(`select save_profile_from_scan($1, $2, false) r`, [U, prof('B')]))[0].r).toBe(true)
  })
  it('main profile: a stale editor still gets its conflict, changed or not', async () => {
    await fresh()
    const { sp } = await mainRow()
    expect(await edit(sp.resumeData, 'stale|')).toBe(false)
    expect(await edit(rd('other'), 'stale|')).toBe(false)
  })
  it('main profile: a real change still stamps the marker and keeps the previous version', async () => {
    await fresh()
    const before = (await mainRow()).sp
    expect(await edit(rd('A2'), await versionOf())).toBe(true)
    const after = await mainRow()
    expect(after.sp.editedAt).toBeTruthy()
    expect(after.sp.resumeData.name).toBe('A2')
    expect(after.pv.resumeData.name).toBe(before.resumeData.name)
  })
  it('additional profile: unchanged keeps edited_at as it was; changed stamps it; a rename never does', async () => {
    await q(`delete from saved_profiles where user_id = $1`, [U])
    const id = await addExtra('Extra', rd('X'))
    const call = async (resume, label, version) => (await q(`select update_saved_profile($1, $2, $3, $4, $5, now()) r`, [U, id, resume, label, version ?? null]))[0].r
    const editedAt = async () => (await q(`select edited_at from saved_profiles where id = $1`, [id]))[0].edited_at
    expect(await call(rd('X'), null)).toBe('ok')
    expect(await editedAt()).toBeNull()
    expect(await call(null, 'Renamed')).toBe('ok')
    expect(await editedAt()).toBeNull()
    expect(await call(rd('X2'), null)).toBe('ok')
    expect(await editedAt()).not.toBeNull()
    const stamped = (await editedAt()).toISOString()
    expect(await call(rd('X2'), null)).toBe('ok')                    // same again: marker untouched
    expect((await editedAt()).toISOString()).toBe(stamped)
  })
  it('additional profile: a stale version is a conflict even when nothing changed', async () => {
    await q(`delete from saved_profiles where user_id = $1`, [U])
    const id = await addExtra('Extra2', rd('Y'))
    const [{ r }] = await q(`select update_saved_profile($1, $2, $3, null, '2020-01-01T00:00:00Z', now()) r`, [U, id, rd('Y')])
    expect(r).toBe('conflict')
  })
})
