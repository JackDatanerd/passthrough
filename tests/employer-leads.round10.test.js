import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Employer leads, round 10 (Section 5). An in-memory employer_leads table
// with the real unique(lower(email)) behaviour stands in for Postgres.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const HOURS = h => h * 60 * 60 * 1000
const SECRET = 'test-secret-'.padEnd(40, 'x')
const sha = (email) => createHash('sha256').update(email).digest('hex')

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
        const [col, op, ...rest] = cl.split('.'); const val = rest.join('.')
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
      if (q.op === 'insert' && Array.isArray(q.values)) {
        if (state.failBatchInsert || q.values.some(v => rows.some(r => r.email.toLowerCase() === v.email.toLowerCase())))
          return { error: { code: '23505', message: 'duplicate key' } }
        q.values.forEach(v => { state.inserts++; rows.push({ id: `gen-${++seq}`, status: 'NEW', submission_count: 1, created_at: new Date().toISOString(),
          last_submitted_at: new Date().toISOString(), notes: null, contacted_at: null, ...v }) })
        return { data: null, error: null }
      }
      if (q.op === 'insert') {
        if (rows.some(r => r.email.toLowerCase() === q.values.email.toLowerCase()))
          return { error: { code: '23505', message: 'duplicate key' } }
        state.inserts++
        const row = { id: `gen-${++seq}`, status: 'NEW', submission_count: 1, created_at: new Date().toISOString(),
          last_submitted_at: new Date().toISOString(), notes: null, contacted_at: null, ...q.values }
        rows.push(row)
        return { data: q.returning ? { ...row } : null, error: null }
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
      const h = q.filters.find(f => f[1] === 'email_hash')?.[2]
      if (q.filters.find(f => f[0] === 'in' && f[1] === 'email_hash')) return { data: h.filter(x => state.suppressed.has(x)).map(email_hash => ({ email_hash })), error: null }
      if (q.op === 'upsert') { [].concat(q.values).forEach(v => state.suppressed.add(v.email_hash)); return { data: null, error: null } }
      // TEST FIX (fresh audit pass, Section 5): adminLiftSuppression chains
      // .select().maybeSingle() onto the delete to learn whether a row was
      // actually removed (real Postgres/Supabase returns the deleted row);
      // this used to always answer `data: null`, which made a real deletion
      // indistinguishable from "nothing to delete."
      if (q.op === 'delete') {
        if (liftError) return { data: null, error: liftError }
        const existed = state.suppressed.has(h)
        state.suppressed.delete(h)
        return { data: existed ? { email_hash: h } : null, error: null }
      }
      return { data: state.suppressed.has(h) ? { email_hash: h } : null, error: null }
    }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
    if (q.table === 'email_logs') {
      if (q.op === 'delete') {
        state.logPurges.push(Object.fromEntries(q.filters.map(f => [f[1], f[2]])))
        return { data: null, error: logPurgeError }
      }
      return { data: mailLogs, error: null }
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
      sendEmployerLeadAck: async (env, sb, to, name, field, links) => { state.acks.push({ to, name, field }); state.ackLinks.push(links); return ackResult },
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
      body: (body, status = 200, headers = {}) => ({ raw: body, status, headers }),
      _waits: waits,
    }
  }
  return { mod, restore, state, db, c, env }
}

let t, realErr, realWarn
beforeEach(() => { realErr = console.error; realWarn = console.warn; console.error = () => {}; console.warn = () => {} })
afterEach(() => { console.error = realErr; console.warn = realWarn; t?.restore() })

const valid = (over = {}) => ({ name: 'Dana', company: 'Acme', email: 'Dana@Acme.com', ...over })
const submit = async (body) => { const ctx = t.c({ body }); const res = await t.mod.createLead(ctx); await Promise.all(ctx._waits); return res }
const HOURS_AGO = h => new Date(Date.now() - HOURS(h)).toISOString()
const lead = (over = {}) => ({
  id: ID1, name: 'Dana', company: 'Acme', email: 'dana@acme.com', status: 'NEW', notes: null, contacted_at: null,
  role_category: 'sales', role_title: null, source: 'homepage', source_code: null, submission_count: 1,
  extra_role_categories: [], ack_attempts: 0, last_ack_at: null, confirmed_at: null,
  created_at: HOURS_AGO(72), updated_at: HOURS_AGO(72), last_submitted_at: HOURS_AGO(72), ...over,
})
const admin = async (fn, ctxOver) => { const ctx = t.c(ctxOver); const res = await fn(ctx); await Promise.all(ctx._waits); return res }

describe('an ARCHIVED lead that submits again', () => {
  it('stays archived, is flagged, gets no email, and tells the owner (subject says archived)', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED', confirmed_at: HOURS_AGO(60) })] })
    await submit(valid())
    const row = t.state.leads[0]
    expect(row.status).toBe('ARCHIVED')
    expect(row.submission_count).toBe(2)
    expect(row.archived_resubmitted_at).toBeTruthy()
    expect(t.state.acks).toHaveLength(0)
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.notices[0].subject).toBe('Archived employer lead resubmitted')
    expect(t.state.notices[0].message).toContain('stays archived')
  })
  it('does not repeat the notice inside a week, but flags it every time', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED', last_notice_at: HOURS_AGO(24 * 3) })] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.leads[0].archived_resubmitted_at).toBeTruthy()
  })
  it('announces again after a week', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED', last_notice_at: HOURS_AGO(24 * 8) })] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(1)
  })
  it('a different field on an archived lead is reported, not stored', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED' })] })
    await submit(valid({ roleCategory: 'finance' }))
    expect(t.state.leads[0].extra_role_categories).toEqual([])
    expect(t.state.notices[0].message).toContain('field: Finance')
  })
  it('an admin decision on the status clears the flag (single and bulk)', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED', archived_resubmitted_at: HOURS_AGO(1) }), lead({ id: ID2, email: 'b@b.com', status: 'ARCHIVED', archived_resubmitted_at: HOURS_AGO(1) })] })
    await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { status: 'NEW' } })
    await admin(t.mod.adminBulkUpdateLeads, { body: { ids: [ID2], action: 'setStatus', status: 'ARCHIVED' } })
    expect(t.state.leads.map(l => l.archived_resubmitted_at)).toEqual([null, null])
  })
})

describe('a lead hiring in more than one field', () => {
  const resubmit = async (existing, body) => { t = setup({ leads: [existing] }); await submit(valid(body)); return t.state.leads[0] }
  it('keeps the new field as an extra, once, and names it in the owner notice', async () => {
    const row = await resubmit(lead(), { roleCategory: 'finance' })
    expect(row.role_category).toBe('sales')
    expect(row.extra_role_categories).toEqual(['finance'])
    expect(t.state.notices[0].message).toContain('also hiring in: Finance')
    expect(t.state.notices[0].message).not.toContain('field: Finance')
  })
  it('does not add the same field twice, or the primary field', async () => {
    let row = await resubmit(lead({ extra_role_categories: ['finance'] }), { roleCategory: 'finance' })
    expect(row.extra_role_categories).toEqual(['finance'])
    row = await resubmit(lead(), { roleCategory: 'sales' })
    expect(row.extra_role_categories).toEqual([])
  })
  it('stops at four extras and says so instead of dropping it silently', async () => {
    const row = await resubmit(lead({ extra_role_categories: ['finance', 'design', 'legal', 'operations'] }), { roleCategory: 'data_science' })
    expect(row.extra_role_categories).toHaveLength(4)
    expect(t.state.notices[0].message).toContain('field: Data Science')
  })
})

describe('adminUpdateLeadStatus — email and other fields', () => {
  it('corrects the address, resets confirmation and notice clocks, and asks the new address to confirm', async () => {
    t = setup({ leads: [lead({ confirmed_at: HOURS_AGO(5), last_ack_at: HOURS_AGO(5), ack_attempts: 2, last_candidates_notified_at: HOURS_AGO(4) })] })
    const res = await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { email: ' Dana@Acme.CO ' } })
    expect(res.status).toBe(200)
    expect(res.body.confirmationReset).toBe(true)
    expect(t.state.leads[0]).toMatchObject({ email: 'dana@acme.co', confirmed_at: null, ack_attempts: 0, last_candidates_notified_at: null })
    expect(t.state.acks.map(a => a.to)).toEqual(['dana@acme.co'])
    expect(t.state.audit.find(a => a.action === 'lead.update').detail).toMatchObject({ emailChanged: true })
    expect(JSON.stringify(t.state.audit)).not.toContain('dana@acme.co')
  })
  it('an unchanged address resets nothing', async () => {
    t = setup({ leads: [lead({ confirmed_at: HOURS_AGO(5) })] })
    const res = await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { email: 'DANA@acme.com', name: 'Dana K' } })
    expect(res.body.confirmationReset).toBeUndefined()
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(t.state.acks).toHaveLength(0)
  })
  it('refuses an address on the do-not-contact list, and an invalid one', async () => {
    t = setup({ leads: [lead()], suppressed: [sha('gone@acme.com')] })
    const res = await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { email: 'gone@acme.com' } })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REMOVAL_REQUESTED')
    expect(t.state.leads[0].email).toBe('dana@acme.com')
    await expect(admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { email: 'not-an-email' } })).rejects.toBeTruthy()
  })
  it('an archived lead is not mailed when its address is corrected', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED' })] })
    await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { email: 'new@acme.com' } })
    expect(t.state.acks).toHaveLength(0)
  })
  it('sets other fields without the primary one, drops duplicates, and needs a primary', async () => {
    t = setup({ leads: [lead()] })
    await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { extraRoleCategories: ['finance', 'sales', 'finance', 'design'] } })
    expect(t.state.leads[0].extra_role_categories).toEqual(['finance', 'design'])
    // moving the primary to one of the extras removes it from the extras
    await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { roleCategory: 'finance' } })
    expect(t.state.leads[0].extra_role_categories).toEqual(['design'])
    // clearing the primary clears the extras
    await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { roleCategory: null } })
    expect(t.state.leads[0].extra_role_categories).toEqual([])
    const res = await admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { extraRoleCategories: ['legal'] } })
    expect(res.status).toBe(400)
  })
  it('rejects more than four other fields', async () => {
    t = setup({ leads: [lead()] })
    await expect(admin(t.mod.adminUpdateLeadStatus, { params: { id: ID1 }, body: { extraRoleCategories: ['finance', 'design', 'legal', 'operations', 'data_science'] } })).rejects.toBeTruthy()
  })
})

describe('bulk setField with other fields', () => {
  it('removes the new primary from a lead\'s extras and clears them when the field is cleared', async () => {
    t = setup({ leads: [lead({ extra_role_categories: ['finance', 'design'] }), lead({ id: ID2, email: 'b@b.com', extra_role_categories: ['legal'] })] })
    await admin(t.mod.adminBulkUpdateLeads, { body: { ids: [ID1, ID2], action: 'setField', field: 'finance' } })
    expect(t.state.leads.map(l => l.extra_role_categories)).toEqual([['design'], ['legal']])
    await admin(t.mod.adminBulkUpdateLeads, { body: { ids: [ID1, ID2], action: 'setField', field: null } })
    expect(t.state.leads.map(l => l.extra_role_categories)).toEqual([[], []])
  })
})

describe('list filters and tallies', () => {
  const three = () => [
    lead({ id: ID1, email: 'a@b.com', role_category: 'sales', extra_role_categories: ['finance'] }),
    lead({ id: ID2, email: 'b@b.com', role_category: 'finance' }),
    lead({ id: '33333333-3333-4333-8333-333333333333', email: 'c@b.com', role_category: 'design', last_ack_at: HOURS_AGO(1), confirmed_at: HOURS_AGO(1) }),
  ]
  it('a field filter also finds leads that list it as another field', async () => {
    t = setup({ leads: three() })
    const res = await admin(t.mod.adminListLeads, { query: { field: 'finance' } })
    expect(res.body.data.map(l => l.email).sort()).toEqual(['a@b.com', 'b@b.com'])
    expect(res.body.data.find(l => l.email === 'a@b.com').extraRoleCategories).toEqual(['finance'])
  })
  it('ack=never lists unconfirmed leads we have not emailed; archived ones are not counted', async () => {
    t = setup({ leads: [...three(), lead({ id: '44444444-4444-4444-8444-444444444444', email: 'd@b.com', status: 'ARCHIVED' })] })
    const res = await admin(t.mod.adminListLeads, { query: { ack: 'never' } })
    expect(res.body.data.map(l => l.email).sort()).toEqual(['a@b.com', 'b@b.com'])
    expect(res.body.meta.neverEmailed).toBe(2)
  })
  it('reengaged=yes lists archived leads that came back', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED', archived_resubmitted_at: HOURS_AGO(2) }), lead({ id: ID2, email: 'b@b.com', status: 'ARCHIVED' })] })
    const res = await admin(t.mod.adminListLeads, { query: { reengaged: 'yes' } })
    expect(res.body.data.map(l => l.email)).toEqual(['dana@acme.com'])
    expect(res.body.meta.reengaged).toBe(1)
  })
  it('the CSV carries the new columns after the lead id', async () => {
    t = setup({ leads: [lead({ extra_role_categories: ['finance', 'design'], ack_attempts: 3 })] })
    const res = await admin(t.mod.adminExportLeads, {})
    const [header, line] = res.raw.replace('\uFEFF', '').split('\r\n')
    expect(header.endsWith('"Lead id","Also hiring in","Acknowledgement attempts (sweep)","Resubmitted while archived at"')).toBe(true)
    expect(line).toContain('"finance; design","3",""')
  })
})

describe('adminNotifyCandidates — leads hiring in more than one field', () => {
  it('reaches a lead whose OTHER field has candidates', async () => {
    t = setup({ supply: [{ role_category: 'finance', candidate_count: 3 }],
      leads: [lead({ confirmed_at: HOURS_AGO(9), extra_role_categories: ['finance'] }), lead({ id: ID2, email: 'x@y.com', role_category: 'design', confirmed_at: HOURS_AGO(9) })] })
    const res = await admin(t.mod.adminNotifyCandidates, { body: { field: 'finance' } })
    expect(res.body.data.sent).toBe(1)
    expect(t.state.candidateMails.map(m => m.to)).toEqual(['dana@acme.com'])
  })
})

describe('adminImportLeads', () => {
  const rows = (...r) => ({ rows: r, attest: true })
  it('requires the attestation and between 1 and 500 rows', async () => {
    t = setup()
    await expect(admin(t.mod.adminImportLeads, { body: { rows: [{ name: 'A', company: 'B', email: 'a@b.com' }] } })).rejects.toBeTruthy()
    await expect(admin(t.mod.adminImportLeads, { body: { rows: [], attest: true } })).rejects.toBeTruthy()
    await expect(admin(t.mod.adminImportLeads, { body: { rows: Array(501).fill({}), attest: true } })).rejects.toBeTruthy()
    expect(t.state.leads).toHaveLength(0)
  })
  it('imports confirmed manual leads, maps field names, and reports every kind of skipped row', async () => {
    t = setup({ leads: [lead({ email: 'have@acme.com' })], suppressed: [sha('gone@acme.com')] })
    const res = await admin(t.mod.adminImportLeads, { body: rows(
      { name: 'New One', company: 'Acme', email: 'New@Acme.com', field: 'Data Science', role: 'ML lead', notes: 'met at conf' },
      { name: 'Other', company: 'Acme', email: 'other@acme.com', field: 'Astronaut' },
      { name: 'Dup', company: 'Acme', email: 'new@acme.com' },
      { name: 'Have', company: 'Acme', email: 'have@acme.com' },
      { name: 'Gone', company: 'Acme', email: 'gone@acme.com' },
      { name: '', company: 'Acme', email: 'blank@acme.com' },
      { name: 'Bad', company: 'Acme', email: 'nope' },
    ) })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ created: 2, invalid: 2, duplicateInFile: 1, exists: 1, removed: 1, fieldIgnored: 1 })
    const created = t.state.leads.filter(l => l.source === 'manual')
    expect(created.map(l => l.email).sort()).toEqual(['new@acme.com', 'other@acme.com'])
    expect(created.every(l => l.confirmed_at && l.status === 'NEW')).toBe(true)
    expect(created.find(l => l.email === 'new@acme.com')).toMatchObject({ role_category: 'data_science', role_title: 'ML lead', notes: 'met at conf' })
    expect(created.find(l => l.email === 'other@acme.com').role_category).toBeNull()
    expect(res.body.data.problems.map(p => p.line).sort()).toEqual([2, 3, 4, 5, 6, 7])
    expect(t.state.acks).toHaveLength(0)           // vouched for by the admin: nobody is mailed
    expect(t.state.suppressed.has(sha('gone@acme.com'))).toBe(true)   // never lifted by an import
    expect(t.state.audit.find(a => a.action === 'lead.import').detail).toMatchObject({ created: 2 })
  })
  it('looks addresses up in small groups so the request URL stays short', async () => {
    t = setup()
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `N${i}`, company: 'Acme', email: `p${i}@acme.com` }))
    const res = await admin(t.mod.adminImportLeads, { body: { rows: many, attest: true } })
    expect(res.body.data.created).toBe(120)
    const lookups = t.db.calls.filter(c => c.table === 'employer_leads' && c.op === 'select').flatMap(c => c.filters.filter(f => f[0] === 'in').map(f => f[2].length))
    expect(Math.max(...lookups)).toBeLessThanOrEqual(50)
    const hashLookups = t.db.calls.filter(c => c.table === 'employer_lead_suppressions').flatMap(c => c.filters.filter(f => f[0] === 'in').map(f => f[2].length))
    expect(Math.max(...hashLookups)).toBeLessThanOrEqual(50)
  })
  it('a dry run writes nothing and says what would happen', async () => {
    t = setup()
    const res = await admin(t.mod.adminImportLeads, { body: { ...rows({ name: 'A', company: 'B', email: 'a@b.com' }), dryRun: true } })
    expect(res.body.data).toMatchObject({ dryRun: true, created: 0, wouldCreate: 1 })
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.audit).toHaveLength(0)
  })
  it('when the batch insert collides with a lead added a moment ago, the rest still go in', async () => {
    t = setup({ leads: [] })
    t.state.failBatchInsert = true
    // simulate the race: the second address appears between the existence check and the insert
    const origPush = t.state.leads.push.bind(t.state.leads)
    const res = await admin(t.mod.adminImportLeads, { body: rows({ name: 'A', company: 'B', email: 'a@b.com' }, { name: 'C', company: 'D', email: 'c@d.com' }) })
    expect(res.body.data.created).toBe(2)
    expect(t.state.leads.map(l => l.email).sort()).toEqual(['a@b.com', 'c@d.com'])
    void origPush
  })
})

describe('sweepUnacknowledgedLeads', () => {
  const sweep = (over = {}) => t.mod.sweepUnacknowledgedLeads({ ...t.env, ...over }, t.db)
  it('sends the confirmation to a lead that never got one, stamps the attempt, and leaves the rest alone', async () => {
    t = setup({ leads: [
      lead({ id: ID1, email: 'late@a.com' }),
      lead({ id: ID2, email: 'recent@a.com', created_at: HOURS_AGO(0.1) }),                       // inside the grace period
      lead({ id: '33333333-3333-4333-8333-333333333333', email: 'confirmed@a.com', confirmed_at: HOURS_AGO(3) }),
      lead({ id: '44444444-4444-4444-8444-444444444444', email: 'archived@a.com', status: 'ARCHIVED' }),
      lead({ id: '55555555-5555-4555-8555-555555555555', email: 'acked@a.com', last_ack_at: HOURS_AGO(2) }),
      lead({ id: '66666666-6666-4666-8666-666666666666', email: 'gaveup@a.com', ack_attempts: 5 }),
      lead({ id: '77777777-7777-4777-8777-777777777777', email: 'tried@a.com', ack_attempts: 1, last_ack_attempt_at: HOURS_AGO(1) }),   // inside the retry gap
      lead({ id: '88888888-8888-4888-8888-888888888888', email: 'ancient@a.com', created_at: HOURS_AGO(24 * 70) }),
    ] })
    const r = await sweep()
    expect(r).toMatchObject({ examined: 1, sent: 1, failed: 0, budgetExhausted: false })
    expect(t.state.acks.map(a => a.to)).toEqual(['late@a.com'])
    expect(t.state.leads.find(l => l.email === 'late@a.com')).toMatchObject({ ack_attempts: 1 })
    expect(t.state.leads.find(l => l.email === 'late@a.com').last_ack_attempt_at).toBeTruthy()
    expect(t.state.leads.find(l => l.email === 'late@a.com').last_ack_at).toBeTruthy()
  })
  it('retries a lead after the gap, counts failures, and gives up at the limit', async () => {
    t = setup({ ackResult: false, leads: [lead({ ack_attempts: 4, last_ack_attempt_at: HOURS_AGO(7) })] })
    let r = await sweep()
    expect(r).toMatchObject({ examined: 1, sent: 0, failed: 1 })
    expect(t.state.leads[0].ack_attempts).toBe(5)
    r = await sweep()
    expect(r.examined).toBe(0)
  })
  it('stops for the hour when the shared acknowledgement budget is spent, without counting an attempt', async () => {
    t = setup({ kv: { 'rl:leadack:budget': JSON.stringify({ count: 30, windowStart: Date.now(), refunds: 0 }) }, leads: [lead()] })
    const r = await sweep()
    expect(r).toMatchObject({ examined: 1, sent: 0, budgetExhausted: true })
    expect(t.state.acks).toHaveLength(0)
    expect(t.state.leads[0].ack_attempts).toBe(0)
  })
  it('takes the mail log\'s word that an acknowledgement already went out instead of sending another', async () => {
    t = setup({ mailLogs: [{ sent_at: HOURS_AGO(20) }], leads: [lead()] })
    const r = await sweep()
    expect(r).toMatchObject({ adopted: 1, sent: 0 })
    expect(t.state.acks).toHaveLength(0)
    expect(t.state.leads[0].last_ack_at).toBe(t.state.leads[0].last_ack_at && HOURS_AGO(20) && t.state.leads[0].last_ack_at)
    expect(t.state.leads[0].last_ack_at).toBeTruthy()
  })
  it('carries the one-click unsubscribe header only when API_ORIGIN is configured', async () => {
    t = setup({ leads: [lead()] })
    await sweep({ API_ORIGIN: 'https://api.passthrough.dev/' })
    expect(t.state.ackLinks[0].unsubscribeUrl).toMatch(/^https:\/\/api\.passthrough\.dev\/api\/employer-leads\/unsubscribe\?token=/)
    t.state.leads[0].last_ack_at = null; t.state.leads[0].last_ack_attempt_at = null
    await sweep({ API_ORIGIN: undefined })
    expect(t.state.ackLinks[1].unsubscribeUrl).toBeNull()
  })
  it('reports a database error instead of throwing', async () => {
    t = setup()
    const broken = { from: () => { throw new Error('unused') } }
    const db = { ...t.db, from: () => ({ select: () => ({ is: () => ({ is: () => ({ neq: () => ({ lt: () => ({ lt: () => ({ gt: () => ({ or: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ error: { message: 'no such column: ack_attempts' } }) }) }) }) }) }) }) }) }) }) }) }) }
    void broken
    expect(await t.mod.sweepUnacknowledgedLeads(t.env, db)).toEqual({ error: 'no such column: ack_attempts' })
  })
})
