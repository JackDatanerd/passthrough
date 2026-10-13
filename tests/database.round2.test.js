import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { checkSchema, LEDGER_FROM_VERSION } from '../src/lib/health.js'
import constants from '../src/config/constants.js'

// Database layer round 2: the migration ledger (0082). schema_version is one integer, so a database that skipped migration N but
// applied N+1 reported itself current. The ledger lists what actually ran; checkSchema fails when any expected version is missing.

const E = constants.EXPECTED_SCHEMA_VERSION
const db = ({ version = E, ledger, ledgerError } = {}) => createFakeSupabase(q => {
  if (q.table === 'applied_migrations') {
    if (ledgerError) return { data: null, error: { message: ledgerError } }
    return { data: (ledger ?? Array.from({ length: Math.max(0, E - LEDGER_FROM_VERSION + 1) }, (_, i) => LEDGER_FROM_VERSION + i)).map(v => ({ version: v })), error: null }
  }
  if (q.table === 'system_state') return { data: { value: { version }, updated_at: 't' }, error: null }
})

describe('checkSchema + applied_migrations', () => {
  it('the ledger starts at the migration that created it', () => { expect(LEDGER_FROM_VERSION).toBe(82) })
  it('is ok when schema_version matches and every expected migration is in the ledger', async () => {
    expect(await checkSchema(db())).toMatchObject({ ok: true, detail: null })
  })
  it('FAILS when a migration in the middle was skipped, even though schema_version looks current', async () => {
    const all = Array.from({ length: E - LEDGER_FROM_VERSION + 1 }, (_, i) => LEDGER_FROM_VERSION + i)
    const skipped = all[Math.floor(all.length / 2)] ?? LEDGER_FROM_VERSION
    const r = await checkSchema(db({ ledger: all.filter(v => v !== skipped) }))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([skipped])
    expect(r.detail).toMatch(/skipped/)
    expect(r.detail).toContain(String(skipped).padStart(4, '0'))
  })
  it('names every missing migration', async () => {
    const r = await checkSchema(db({ ledger: [] }))
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(Array.from({ length: E - LEDGER_FROM_VERSION + 1 }, (_, i) => LEDGER_FROM_VERSION + i))
  })
  it('a missing ledger table (0082 never applied, a later one was) is a failure that says what to apply', async () => {
    const r = await checkSchema(db({ ledgerError: 'relation "applied_migrations" does not exist' }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/applied_migrations/)
    expect(r.detail).toMatch(/0082/)
  })
  it('a database BEHIND the code is still reported as behind (the ledger is not consulted)', async () => {
    const r = await checkSchema(db({ version: E - 1 }))
    expect(r).toMatchObject({ ok: false, ahead: false })
    expect(r.detail).toMatch(/apply every migration above/)
  })
  it('a database AHEAD of the code stays ok: extra ledger rows are not required of this code', async () => {
    const r = await checkSchema(db({ version: E + 1, ledger: Array.from({ length: E - LEDGER_FROM_VERSION + 2 }, (_, i) => LEDGER_FROM_VERSION + i) }))
    expect(r).toMatchObject({ ok: true, ahead: true })
  })
})
