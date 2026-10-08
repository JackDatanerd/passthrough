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

function setup({ leads = [], supply, kv = {}, suppressed = [], ackResult = true, envExtra = {}, liftError = null, candidateMailResult = true, failContactStamp = false, mailLogs = [], logPurgeError = null } = {}) {
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
        return true
      })
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
      const filtered = rows.filter(match).filter(r => !cutoff || !r.last_candidates_notified_at || r.last_candidates_notified_at < cutoff)
      // PostgREST answers an offset past the end with 416 when a count was requested.
      if (q.range && q.range[0] > 0 && q.range[0] >= filtered.length && q.selectOpts?.count)
        return { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
      return { data: filtered.slice(q.range ? q.range[0] : 0, q.range ? q.range[1] + 1 : q.limit || undefined), count: filtered.length, error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      const h = q.filters.find(f => f[1] === 'email_hash')?.[2]
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

// ── Independent audit round 9, Section 5 ────────────────────────────────────
const HOURS_AGO = h => new Date(Date.now() - HOURS(h)).toISOString()
const lead = (over = {}) => ({ id: ID1, name: 'Dana', company: 'Acme', email: 'dana@acme.com', status: 'NEW',
  role_category: 'sales', role_title: null, source: 'homepage', source_code: null, submission_count: 1,
  created_at: HOURS_AGO(72), updated_at: HOURS_AGO(72), last_submitted_at: HOURS_AGO(72), notes: null,
  contacted_at: null, confirmed_at: null, last_ack_at: null, last_notice_at: null, ...over })

describe('archived leads are never mailed a confirmation by an admin action', () => {
  it('bulk requestConfirmation skips ARCHIVED leads and counts them as skipped', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED' }), lead({ id: ID2, email: 'sam@acme.com' })] })
    const res = await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1, ID2], action: 'requestConfirmation' } }))
    expect(res.body.sent).toBe(1)
    expect(res.body.skipped).toBe(1)
    expect(t.state.acks.map(a => a.to)).toEqual(['sam@acme.com'])
  })
  it('the single endpoint refuses an ARCHIVED lead with a 409 and sends nothing', async () => {
    t = setup({ leads: [lead({ status: 'ARCHIVED' })] })
    const res = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(409)
    expect(t.state.acks).toHaveLength(0)
  })
  it('still sends for a non-archived unconfirmed lead', async () => {
    t = setup({ leads: [lead()] })
    const res = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(200)
    expect(t.state.acks).toHaveLength(1)
  })
})

describe('a resubmission with different details', () => {
  const resubmit = async (existing, body) => { t = setup({ leads: [existing] }); await submit(valid(body)); return t.state.leads[0] }

  it('keeps the primary field, adds the other as one the lead is also hiring in, does not graft its title, and tells the owner', async () => {
    const row = await resubmit(lead({ confirmed_at: HOURS_AGO(70) }), { roleCategory: 'data_science', roleTitle: 'ML lead', verificationCode: 'ab3xk9' })
    expect(row.role_category).toBe('sales')
    expect(row.extra_role_categories).toEqual(['data_science'])
    expect(row.role_title).toBeNull()
    expect(row.submission_count).toBe(2)
    const msg = t.state.notices[0].message
    expect(msg).toContain('also hiring in: Data Science')
    expect(msg).toContain('role: ML lead')
  })
  it('still fills a title that belongs to the lead\'s own field', async () => {
    const row = await resubmit(lead(), { roleCategory: 'sales', roleTitle: 'Head of Sales' })
    expect(row.role_title).toBe('Head of Sales')
  })
  it('fills field and title together when the lead had neither', async () => {
    const row = await resubmit(lead({ role_category: null }), { roleCategory: 'design', roleTitle: 'Design lead' })
    expect([row.role_category, row.role_title]).toEqual(['design', 'Design lead'])
  })
  it('a different field is announced even inside the 24h notice cooldown (1h instead)', async () => {
    await resubmit(lead({ last_notice_at: HOURS_AGO(3) }), { roleCategory: 'finance' })
    expect(t.state.notices).toHaveLength(1)
  })
  it('a plain repeat inside the 24h cooldown is still silent', async () => {
    await resubmit(lead({ last_notice_at: HOURS_AGO(3) }), { roleCategory: 'sales' })
    expect(t.state.notices).toHaveLength(0)
  })
})

describe('suppressed addresses answer like any other', () => {
  it('runs a throwaway lookup so the suppressed path costs the same round trips', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    const res = await submit(valid())
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.db.calls.some(q => q.table === 'employer_leads' && q.op === 'select')).toBe(true)
  })
})

describe('the confirmed page can set the lead\'s field', () => {
  const tok = async (purpose, email = 'dana@acme.com') => (await import('../src/lib/leadTokens.js')).signLeadToken(SECRET, purpose, email)

  it('confirm tells the page when no field is on file', async () => {
    t = setup({ leads: [lead({ role_category: null })] })
    const res = await t.mod.confirmLead(t.c({ body: { token: await tok('confirm') } }))
    expect(res.body.status).toBe('confirmed')
    expect(res.body.needsField).toBe(true)
  })
  it('confirm does not ask when a field is already set', async () => {
    t = setup({ leads: [lead()] })
    const res = await t.mod.confirmLead(t.c({ body: { token: await tok('confirm') } }))
    expect(res.body.needsField).toBe(false)
  })
  it('saves the field with a valid confirm token', async () => {
    t = setup({ leads: [lead({ role_category: null })] })
    const res = await t.mod.setLeadField(t.c({ body: { token: await tok('confirm'), field: 'design' } }))
    expect(res.body).toMatchObject({ success: true, status: 'saved' })
    expect(t.state.leads[0].role_category).toBe('design')
    expect(t.state.leads[0].name).toBe('Dana')
  })
  it('a remove token cannot set a field', async () => {
    t = setup({ leads: [lead({ role_category: null })] })
    const res = await t.mod.setLeadField(t.c({ body: { token: await tok('remove'), field: 'design' } }))
    expect(res.status).toBe(400)
    expect(t.state.leads[0].role_category).toBeNull()
  })
  it('rejects a field outside the taxonomy', async () => {
    t = setup({ leads: [lead({ role_category: null })] })
    await expect(t.mod.setLeadField(t.c({ body: { token: await tok('confirm'), field: 'astronaut' } }))).rejects.toThrow()
  })
  it('answers not_found for an address with no lead', async () => {
    t = setup({ leads: [] })
    const res = await t.mod.setLeadField(t.c({ body: { token: await tok('confirm'), field: 'design' } }))
    expect(res.body.status).toBe('not_found')
  })
})
