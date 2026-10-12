import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Employer leads (public form + admin list). An in-memory employer_leads table
// with the real unique(lower(email)) behaviour stands in for Postgres.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const HOURS = h => h * 60 * 60 * 1000
const SECRET = 'test-secret-'.padEnd(40, 'x')
const sha = (email) => createHash('sha256').update(email).digest('hex')
// The export is a stream now; the fake context's c.body() drains it so tests can keep reading `res.raw` as text.
const drainBody = (body, status = 200, headers = {}) => {
  if (typeof body === 'string') return { raw: body, status, headers }
  return (async () => { const dec = new TextDecoder('utf-8', { ignoreBOM: true }); let out = ''; const rd = body.getReader()
    for (;;) { const { value, done } = await rd.read(); if (done) break; out += dec.decode(value) }
    return { raw: out, status, headers } })()
}

function setup({ leads = [], supply, kv = {}, suppressed = [], ackResult = true, envExtra = {}, liftError = null, candidateMailResult = true, failContactStamp = false, mailLogs = [], logPurgeError = null, updateExtrasError = null } = {}) {
  const state = { leads: leads.map(l => ({ ...l })), notices: [], alerts: [], acks: [], ackLinks: [], candidateMails: [], inserts: 0, kv,
    suppressed: new Set(suppressed), audit: [], logPurges: [] }
  let seq = 0
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      const rows = state.leads
      const match = r => q.filters.every((f) => {
        const [op, col, val] = f
        if (op === 'eq') return r[col] === val
        if (op === 'neq') return r[col] !== val
        if (op === 'in') return val.includes(r[col])
        if (op === 'is') return (r[col] ?? null) === val
        if (op === 'not') return f[2] === 'is' ? (r[col] ?? null) !== f[3] : true
        if (op === 'lt')  return r[col] != null && r[col] < val
        if (op === 'gt')  return r[col] != null && r[col] > val
        return true
      })
      // Round 10: a small evaluator for the `.or()` clauses the controller builds (field match across
      // the primary and "other" fields, the notify cooldown, the ack sweep's retry gap).
      const splitTop = (str) => { const out = []; let d = 0, cur = ''
        for (const ch of str) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = '' } else cur += ch }
        if (cur) out.push(cur); return out }
      const clause = (cl, r) => {
        if (cl.startsWith('and(')) return splitTop(cl.slice(4, -1)).every(x => clause(x, r))
        const [rawCol, op, ...rest] = cl.split('.'); const val = rest.join('.')
        // Round 11: `candidates_notified_fields->>sales` reads one key of a jsonb column.
        const [base, key] = rawCol.split('->>')
        const col = rawCol
        if (key !== undefined) r = { ...r, [col]: (r[base] || {})[key] ?? null }
        if (op === 'eq') return String(r[col]) === val
        if (op === 'cs') return Array.isArray(r[col]) && val.replace(/[{}]/g, '').split(',').every(v => r[col].includes(v))
        if (op === 'is') return (r[col] ?? null) === null
        if (op === 'lt') return r[col] != null && r[col] < val
        if (op === 'not') return (r[col] ?? null) !== null
        if (op === 'gte') return r[col] != null && r[col] >= Number(val)
        return true
      }
      const orOk = r => (q.or || []).filter(e => !/(created_at|last_submitted_at)\.lt\./.test(e) || /last_ack_attempt_at/.test(e))
        .every(e => splitTop(e).some(cl => clause(cl, r)))
      if (q.op === 'insert') {
        const batch = [].concat(q.values)
        if (batch.some(v => rows.some(r => r.email.toLowerCase() === v.email.toLowerCase())))
          return { error: { code: '23505', message: 'duplicate key' } }
        const made = batch.map(v => {
          state.inserts++
          const row = { id: `gen-${++seq}`, status: 'NEW', submission_count: 1, created_at: new Date().toISOString(),
            last_submitted_at: new Date().toISOString(), notes: null, contacted_at: null, candidates_notified_fields: {}, ...v }
          rows.push(row)
          return row
        })
        return { data: q.returning ? { ...made[0] } : null, error: null }
      }
      if (q.op === 'update') {
        if (q.patch && 'extra_role_categories' in q.patch && updateExtrasError) return { data: null, error: updateExtrasError }
        // Independent audit round 7: lets a test fail ONLY the first-contact stamp (a lone contacted_at patch).
        if (failContactStamp && Object.keys(q.patch || {}).join() === 'contacted_at') return { data: null, error: { message: 'stamp failed' } }
        const hit = rows.filter(match)
        hit.forEach(r => Object.assign(r, q.patch))
        if (q.maybe || q.single) return { data: hit[0] ? { ...hit[0] } : null, error: null }
        return { data: hit.map(r => ({ ...r })), error: null }
      }
      if (q.op === 'delete') {
        const hit = rows.filter(match)
        hit.forEach(r => rows.splice(rows.indexOf(r), 1))
        if (q.maybe || q.single) return { data: hit[0] || null, error: null }
        return { data: hit, error: null }
      }
      // select
      if (q.selectOpts?.head) return { count: rows.filter(match).length, error: null }
      if (q.maybe) return { data: rows.find(match) ? { ...rows.find(match) } : null, error: null }
      // Round 8: an export no longer treats a short page as the last one, so it asks again with a
      // keyset cursor until a page comes back empty. Every fixture served by this fake fits in its first
      // page; a cursored request therefore has nothing left to give. (Chunking itself is covered by the
      // tests with their own resolvers.)
      if ((q.or || []).some(e => /(created_at|last_submitted_at)\.lt\./.test(e))) return { data: [], count: 0, error: null }
      // `.or('last_candidates_notified_at.is.null,last_candidates_notified_at.lt.<cutoff>')`
      const orNotified = (q.or || []).find(e => e.includes('last_candidates_notified_at'))
      const cutoff = orNotified && /\.lt\.(.+)$/.exec(orNotified)?.[1]
      const filtered = rows.filter(match).filter(orOk).filter(r => !cutoff || !r.last_candidates_notified_at || r.last_candidates_notified_at < cutoff)
      // PostgREST answers an offset past the end with 416 when a count was requested.
      if (q.range && q.range[0] > 0 && q.range[0] >= filtered.length && q.selectOpts?.count)
        return { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
      return { data: filtered.slice(q.range ? q.range[0] : 0, q.range ? q.range[1] + 1 : q.limit || undefined), count: filtered.length, error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      // Round 11: lookups are `.in('email_hash', [every hash form of the address])`.
      const hf = q.filters.find(f => f[1] === 'email_hash')
      const hs = hf ? [].concat(hf[2]) : []
      state.reasons = state.reasons || new Map()
      if (q.op === 'upsert') { [].concat(q.values).forEach(v => { if (!state.suppressed.has(v.email_hash)) state.reasons.set(v.email_hash, v.reason ?? null); state.suppressed.add(v.email_hash) }); return { data: null, error: null } }
      if (q.op === 'update') { hs.forEach(h => { if (state.suppressed.has(h) && q.patch.reason) state.reasons.set(h, q.patch.reason) }); return { data: null, error: null } }
      // TEST FIX (fresh audit pass, Section 5): adminLiftSuppression chains
      // .select().maybeSingle() onto the delete to learn whether a row was
      // actually removed (real Postgres/Supabase returns the deleted row);
      // this used to always answer `data: null`, which made a real deletion
      // indistinguishable from "nothing to delete."
      if (q.op === 'delete') {
        if (state.liftError || liftError) return { data: null, error: state.liftError || liftError }
        const hit = hs.filter(h => state.suppressed.has(h))
        hit.forEach(h => state.suppressed.delete(h))
        return { data: hit.map(h => ({ email_hash: h })), error: null }
      }
      if (q.selectOpts?.head) return { count: state.suppressed.size, error: null }
      return { data: hs.filter(h => state.suppressed.has(h)).map(h => ({ email_hash: h, reason: state.reasons.get(h) ?? null, created_at: '2026-01-01T00:00:00.000Z' })), error: null }
    }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
    if (q.table === 'email_logs') {
      if (q.op === 'delete') {
        state.logPurges.push(Object.fromEntries(q.filters.map(f => [f[1], f[2]])))
        return { data: null, error: logPurgeError }
      }
      return { data: mailLogs, error: null }
    }
    if (q.op === 'rpc' && q.name === 'set_lead_field') {
      const hit = state.leads.filter(l => q.args.p_ids.includes(l.id))
      hit.forEach(l => { l.role_category = q.args.p_field; l.extra_role_categories = q.args.p_field ? (l.extra_role_categories || []).filter(x => x !== q.args.p_field) : [] })
      return { data: hit.map(l => ({ id: l.id })), error: null }
    }
    if (q.op === 'rpc' && q.name === 'verified_candidate_counts')
      return supply === 'error' ? { error: { message: 'no such function' } } : { data: supply || [], error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerNotice: async (env, subject, message) => { state.notices.push({ subject, message }) },
      sendOwnerAlert: async (...a) => { state.alerts.push(a) },
      sendEmployerLeadAck: async (env, sb, to, name, field, links) => {
        state.acks.push({ to, name, field }); state.ackLinks.push(links)
        // A string result ('throttled' | 'suppressed') is a refusal with that reason, as email.service reports it.
        if (typeof ackResult === 'string') { if (links && links.outcome) links.outcome.status = ackResult; return false }
        return ackResult
      },
      sendEmployerCandidatesAvailable: async (env, sb, to, name, field, count, links) => { state.candidateMails.push({ to, name, field, count, links }); return typeof candidateMailResult === 'function' ? candidateMailResult(to) : candidateMailResult },
    },
  })
  const env = { RATE_LIMIT_KV: { get: async k => state.kv[k] ?? null, put: async (k, v) => { state.kv[k] = v } },
    JWT_SECRET: SECRET, FRONTEND_URL: 'https://passthrough.dev', ...envExtra }
  const c = (over = {}) => {
    const waits = []
    return {
      env,
      get: (k) => k === 'user' ? { id: 'admin-1', role: 'ADMIN' } : undefined,
      executionCtx: { waitUntil: p => waits.push(p) },
      req: { json: async () => over.body, param: k => (over.params || {})[k], query: k => (over.query || {})[k] },
      json: (body, status = 200) => ({ body, status }),
      // A streamed export is drained here, so tests read `res.raw` as text exactly as before.
      body: (body, status = 200, headers = {}) => {
        if (typeof body === 'string') return { raw: body, status, headers }
        return (async () => { const dec = new TextDecoder('utf-8', { ignoreBOM: true }); let out = ''; const rd = body.getReader()
          for (;;) { const { value, done } = await rd.read(); if (done) break; out += dec.decode(value) }
          return { raw: out, status, headers } })()
      },
      _waits: waits,
    }
  }
  return { mod, restore, state, db, c, env }
}


let t, realErr, realWarn
beforeEach(() => { realErr = console.error; realWarn = console.warn; console.error = () => {}; console.warn = () => {} })
afterEach(() => { console.error = realErr; console.warn = realWarn; t?.restore() })

// ── Employer leads, round 12 (independent audit, Section 5) ─────────────────────────────────────────
const tokenFor = (purpose, email) => import('../src/lib/leadTokens.js').then(m => (m.default || m).signLeadToken(SECRET, purpose, email))
const mk = (over = {}) => {
  const email = over.email || 'dana@acme.com'
  return { id: ID1, name: 'Dana', company: 'Acme', email, mailbox_key: canon(email), status: 'NEW', role_category: 'sales', extra_role_categories: [],
    created_at: '2026-01-01T00:00:00.000Z', last_submitted_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    submission_count: 1, ack_attempts: 0, last_ack_at: null, confirmed_at: null, ...over }
}
const canon = (e) => import_canon(e)
let import_canon
beforeEach(async () => { import_canon = (await import('../src/lib/mailbox.js')).default?.canonicalMailbox || (await import('../src/lib/mailbox.js')).canonicalMailbox })
const call = (fn, body, extra = {}) => fn(t.c({ body, ...extra }))
const supply = [{ role_category: 'sales', candidate_count: '3' }]


describe('B1 — removing an address removes every lead of that inbox', () => {
  it('the lookup says a lead exists when only another spelling of the inbox is a lead', async () => {
    t = setup({ leads: [mk({ id: ID2, email: 'alice+jobs@corp.com' })] })
    const res = await call(t.mod.adminCheckSuppression, { email: 'alice@corp.com' })
    expect(res.body.data.leadExists).toBe(true)
  })
})

describe('B3 — rejoin can be retried after a failed lift', () => {
  it('a block that is not the person\'s to re-open (admin / complaint) stays, and the page says so', async () => {
    t = setup({ suppressed: [sha('bob@corp.com')], leads: [mk({ id: ID1, email: 'bob@corp.com' })] })
    t.state.reasons = new Map([[sha('bob@corp.com'), 'complaint']])
    const res = await call(t.mod.rejoinLead, { token: await tokenFor('rejoin', 'bob@corp.com'), name: 'Bob', company: 'Corp' })
    expect(res.body.status).toBe('unavailable')
    expect(t.state.suppressed.has(sha('bob@corp.com'))).toBe(true)
  })
})


describe('B4/B5 — the public form schema', () => {
  it('a too-long verification code or job title never costs the lead (cut / dropped, stored)', async () => {
    t = setup()
    const res = await call(t.mod.createLead, { name: 'Eve', company: 'Acme', email: 'eve@acme.com', verificationCode: 'x'.repeat(40), roleCategory: 'Head of '.repeat(30) })
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.leads[0].source_code).toBe(null)
    expect(t.state.leads[0].role_title.length).toBeLessThanOrEqual(100)
  })
})

describe('B8 — admin add on a database that has not run 0068', () => {
  it('retries without consent / confirmed_via instead of answering 500', async () => {
    t = setup()
    const real = t.db.from
    let first = true
    t.db.from = (table) => {
      const b = real(table)
      if (table !== 'employer_leads') return b
      const ins = b.insert.bind(b)
      b.insert = (values) => {
        const api = ins(values)
        if (first && !Array.isArray(values) && 'consent' in values) { first = false; return { select: () => ({ single: async () => ({ data: null, error: { code: '42703', message: 'column consent does not exist' } }) }) } }
        return api
      }
      return b
    }
    const res = await call(t.mod.adminCreateLead, { name: 'Dee', company: 'Acme', email: 'dee@acme.com' })
    expect(res.status).toBe(201)
    expect(t.state.leads[0]).not.toHaveProperty('consent')
  })
})

describe('B9/B11/B12 — editing a lead', () => {
  const patch = (body) => t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body }))
  it('refuses a save from a stale screen (409 LEAD_CHANGED) and changes nothing', async () => {
    t = setup({ leads: [mk({ id: ID1, extra_role_categories: ['design'], updated_at: '2026-02-01T00:00:00.000Z' })] })
    const res = await patch({ name: 'Dana K', extraRoleCategories: [], expectedUpdatedAt: '2026-01-01T00:00:00.000Z' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('LEAD_CHANGED')
    expect(t.state.leads[0].extra_role_categories).toEqual(['design'])
    expect(t.state.leads[0].name).toBe('Dana')
  })
  it('saves when the screen is current, and an old client that sends no version still works', async () => {
    t = setup({ leads: [mk({ id: ID1, updated_at: '2026-02-01T00:00:00.000Z' })] })
    expect((await patch({ name: 'Dana K', expectedUpdatedAt: '2026-02-01T00:00:00.000Z' })).status).toBe(200)
    expect((await patch({ company: 'Acme Inc' })).status).toBe(200)
    expect(t.state.leads[0]).toMatchObject({ name: 'Dana K', company: 'Acme Inc' })
  })
  it('a write that lands between the read and the save is a conflict, not an overwrite', async () => {
    t = setup({ leads: [mk({ id: ID1, updated_at: '2026-02-01T00:00:00.000Z' })] })
    const real = t.db.from
    t.db.from = (table) => {   // someone else saves right after our read
      const b = real(table)
      if (table === 'employer_leads') { const upd = b.update.bind(b); b.update = (pt) => { t.state.leads[0].updated_at = '2026-03-01T00:00:00.000Z'; return upd(pt) } }
      return b
    }
    const res = await patch({ notes: 'x' })
    expect(res.status).toBe(409)
  })
})

describe('G — duplicates and merge', () => {
  it('lists leads that share a mailbox, grouped, and says when the list was cut off', async () => {
    t = setup()
    t.db.rpc = async (name) => name === 'duplicate_leads' ? { data: [
      { id: ID1, mailbox_key: 'a@x.com', email: 'a@x.com', name: 'A', company: 'X', status: 'NEW', role_category: 'sales', confirmed_at: null, created_at: '2026-01-01', submission_count: 1 },
      { id: ID2, mailbox_key: 'a@x.com', email: 'a+1@x.com', name: 'A', company: 'X', status: 'NEW', role_category: null, confirmed_at: null, created_at: '2026-01-02', submission_count: 2 }], error: null } : { data: [], error: null }
    const res = await t.mod.adminListDuplicates(t.c())
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ mailbox: 'a@x.com' })
    expect(res.body.data[0].leads.map(l => l.id)).toEqual([ID1, ID2])
  })
  it('reports a database without 0076 as such', async () => {
    t = setup(); t.db.rpc = async () => ({ data: null, error: { code: '42883', message: 'no function' } })
    const res = await t.mod.adminListDuplicates(t.c())
    expect(res.status).toBe(409)
  })
  it('merges into the kept lead: counts add up, the furthest status, confirmation, notes and every field carry over, the others are deleted', async () => {
    t = setup({ leads: [
      mk({ id: ID1, email: 'a@x.com', role_category: 'sales', extra_role_categories: [], notes: 'first', submission_count: 1, status: 'NEW' }),
      mk({ id: ID2, email: 'a+eng@x.com', role_category: 'design', extra_role_categories: ['data_science'], notes: 'second', submission_count: 3, status: 'CONTACTED',
        contacted_at: '2026-02-01T00:00:00.000Z', confirmed_at: '2026-02-02T00:00:00.000Z', confirmed_via: 'link', last_submitted_at: '2026-03-01T00:00:00.000Z' })] })
    const res = await call(t.mod.adminMergeLeads, { keepId: ID1, mergeIds: [ID2] })
    expect(res.body).toMatchObject({ success: true, data: { id: ID1, merged: 1 } })
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.leads[0]).toMatchObject({ id: ID1, submission_count: 4, status: 'CONTACTED', contacted_at: '2026-02-01T00:00:00.000Z',
      confirmed_at: '2026-02-02T00:00:00.000Z', confirmed_via: 'link', last_submitted_at: '2026-03-01T00:00:00.000Z', role_category: 'sales' })
    expect(t.state.leads[0].extra_role_categories.sort()).toEqual(['data_science', 'design'])
    expect(t.state.leads[0].notes).toBe('first\n---\nsecond')
    expect(t.state.audit.some(a => a.action === 'lead.merge')).toBe(true)
  })
  it('refuses to merge different mailboxes, itself, or a lead that has gone', async () => {
    t = setup({ leads: [mk({ id: ID1, email: 'a@x.com' }), mk({ id: ID2, email: 'b@y.com' })] })
    expect((await call(t.mod.adminMergeLeads, { keepId: ID1, mergeIds: [ID2] })).status).toBe(400)
    await expect(call(t.mod.adminMergeLeads, { keepId: ID1, mergeIds: [ID1] })).rejects.toBeTruthy()
    expect((await call(t.mod.adminMergeLeads, { keepId: ID1, mergeIds: ['33333333-3333-4333-8333-333333333333'] })).status).toBe(404)
    expect(t.state.leads).toHaveLength(2)
  })
})

describe('G — notify: who it would reach, and picking leads', () => {
  const confirmed = (o) => mk({ confirmed_at: '2026-01-01T00:00:00.000Z', ...o })
  it('the dry run names the people the next send would reach', async () => {
    t = setup({ supply, leads: [confirmed({ id: ID1, email: 'a@x.com' }), confirmed({ id: ID2, email: 'b@y.com' })] })
    const res = await call(t.mod.adminNotifyCandidates, { field: 'sales', dryRun: true })
    expect(res.body.data.preview.map(p => p.email).sort()).toEqual(['a@x.com', 'b@y.com'])
    expect(t.state.candidateMails).toHaveLength(0)
  })
  it('can be limited to hand-picked leads', async () => {
    t = setup({ supply, leads: [confirmed({ id: ID1, email: 'a@x.com' }), confirmed({ id: ID2, email: 'b@y.com' })] })
    const res = await call(t.mod.adminNotifyCandidates, { field: 'sales', ids: [ID2] })
    expect(t.state.candidateMails.map(m => m.to)).toEqual(['b@y.com'])
    expect(res.body.data.sent).toBe(1)
  })
})

describe('G — import: its own source, and the bounce list', () => {
  it('skips an address the mail provider reported as bouncing, and files the rest under source "import"', async () => {
    t = setup()
    const real = t.db.from
    t.db.from = (table) => {
      if (table !== 'email_suppressions') return real(table)
      const api = { select: () => api, in: () => api, then: (res) => Promise.resolve({ data: [{ email_hash: sha('bad@acme.com') }], error: null }).then(res) }
      return api
    }
    const res = await call(t.mod.adminImportLeads, { attest: true, rows: [{ name: 'A', company: 'X', email: 'ok@acme.com' }, { name: 'B', company: 'X', email: 'bad@acme.com' }] })
    expect(res.body.data).toMatchObject({ created: 1, blocked: 1 })
    expect(t.state.leads.map(l => [l.email, l.source])).toEqual([['ok@acme.com', 'import']])
  })
})

describe('G — one entry per mailbox, and the sensitive actions behind the step-up', () => {
  it('a new do-not-contact entry is written under the canonical mailbox only (so it can be lifted from any spelling)', async () => {
    t = setup({ leads: [mk({ id: ID1, email: 'bob+x@corp.com' })] })
    await call(t.mod.removeLead, { token: await tokenFor('remove', 'bob+x@corp.com') })
    expect([...t.state.suppressed]).toEqual([sha('bob@corp.com')])
    const lift = await call(t.mod.adminLiftSuppression, { email: 'bob@corp.com' })
    expect(lift.body.success).toBe(true)
    expect(t.state.suppressed.size).toBe(0)
  })
  it('export, import, destructive bulk actions and the real notify send are wired behind admin.stepUp', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/employer-leads.routes.js'), 'utf8')
    expect(src).toMatch(/router\.get\('\/export\.csv', admin, admin\.stepUp,/)
    expect(src).toMatch(/router\.post\('\/import', admin, admin\.stepUp,/)
    expect(src).toMatch(/router\.post\('\/bulk',\s+admin, admin\.stepUp,/)
    expect(src).toMatch(/router\.post\('\/notify-candidates', admin, admin\.stepUpWhen\(/)
    expect(src).toMatch(/router\.post\('\/merge',\s+admin,/)
    expect(src).toMatch(/router\.get\('\/duplicates', admin,/)
  })
})


describe('B11 follow-up — the retry the lift-failed answer asks for is not refused by the version check', () => {
  it('a block-lift that failed returns the saved row; repeating the save with its updatedAt finishes the job', async () => {
    t = setup({ leads: [mk({ id: ID1, email: 'old@acme.com', updated_at: '2026-02-01T00:00:00.000Z' })], suppressed: [sha('new@acme.com')] })
    const patch = (body) => t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body }))
    t.state.liftError = { message: 'blip', code: 'XX000' }
    const first = await patch({ email: 'new@acme.com', overrideRemoval: true, expectedUpdatedAt: '2026-02-01T00:00:00.000Z' })
    expect(first.status).toBe(409)
    expect(first.body).toMatchObject({ code: 'REMOVAL_LIFT_FAILED', saved: true })
    expect(first.body.data.updatedAt).toBeTruthy()
    t.state.liftError = null
    // the stale version is (correctly) refused ...
    expect((await patch({ email: 'new@acme.com', overrideRemoval: true, expectedUpdatedAt: '2026-02-01T00:00:00.000Z' })).status).toBe(409)
    // ... and the version the answer carried goes through and lifts the block
    const retry = await patch({ email: 'new@acme.com', overrideRemoval: true, expectedUpdatedAt: first.body.data.updatedAt })
    expect(retry.status).toBe(200)
    expect(t.state.suppressed.has(sha('new@acme.com'))).toBe(false)
  })
})
