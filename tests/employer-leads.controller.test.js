import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Employer leads (public form + admin list). An in-memory employer_leads table
// with the real unique(lower(email)) behaviour stands in for Postgres.

const ID1 = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'
const HOURS = h => h * 60 * 60 * 1000

function setup({ leads = [], supply, kv = {} } = {}) {
  const state = { leads: leads.map(l => ({ ...l })), notices: [], alerts: [], inserts: 0, kv }
  let seq = 0
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      const rows = state.leads
      const match = r => q.filters.every(([op, col, val]) => op !== 'eq' || r[col] === val)
      if (q.op === 'insert') {
        if (rows.some(r => r.email.toLowerCase() === q.values.email.toLowerCase()))
          return { error: { code: '23505', message: 'duplicate key' } }
        state.inserts++
        rows.push({ id: `gen-${++seq}`, status: 'NEW', submission_count: 1, created_at: new Date().toISOString(),
          last_submitted_at: new Date().toISOString(), notes: null, contacted_at: null, ...q.values })
        return { data: null, error: null }
      }
      if (q.op === 'update') {
        const r = rows.find(match); if (!r) return { data: null, error: null }
        Object.assign(r, q.patch); return { data: { ...r }, error: null }
      }
      if (q.op === 'delete') {
        const i = rows.findIndex(match); if (i < 0) return { data: null, error: null }
        return { data: rows.splice(i, 1)[0], error: null }
      }
      // select
      if (q.selectOpts?.head) {
        return { count: rows.filter(r => q.filters.every(([op, col, val]) => op !== 'eq' || r[col] === val)).length, error: null }
      }
      if (q.maybe) return { data: rows.find(match) ? { ...rows.find(match) } : null, error: null }
      const filtered = rows.filter(match)
      return { data: filtered.slice(q.range ? q.range[0] : 0, q.range ? q.range[1] + 1 : undefined), count: filtered.length, error: null }
    }
    if (q.op === 'rpc' && q.name === 'verified_candidate_counts')
      return supply === 'error' ? { error: { message: 'no such function' } } : { data: supply || [], error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerNotice: async (env, subject, message) => { state.notices.push({ subject, message }) }, sendOwnerAlert: async (...a) => { state.alerts.push(a) } },
  })
  const env = { RATE_LIMIT_KV: { get: async k => state.kv[k] ?? null, put: async (k, v) => { state.kv[k] = v } } }
  const c = (over = {}) => {
    const waits = []
    return {
      env,
      executionCtx: { waitUntil: p => waits.push(p) },
      req: { json: async () => over.body, param: k => (over.params || {})[k], query: k => (over.query || {})[k] },
      json: (body, status = 200) => ({ body, status }),
      body: (body, status = 200, headers = {}) => ({ raw: body, status, headers }),
      _waits: waits,
    }
  }
  return { mod, restore, state, db, c }
}

let t, realErr, realWarn
beforeEach(() => { realErr = console.error; realWarn = console.warn; console.error = () => {}; console.warn = () => {} })
afterEach(() => { console.error = realErr; console.warn = realWarn; t?.restore() })

const valid = (over = {}) => ({ name: 'Dana', company: 'Acme', email: 'Dana@Acme.com', ...over })
const submit = async (body) => { const ctx = t.c({ body }); const res = await t.mod.createLead(ctx); await Promise.all(ctx._waits); return res }

describe('createLead — new lead', () => {
  it('stores a normalized row, notifies the owner (email only) via waitUntil, and never touches alert_logs', async () => {
    t = setup()
    const res = await submit(valid({ roleCategory: 'software_engineering', roleTitle: 'Senior Engineer', source: 'homepage', verificationCode: 'ab3xk9' }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads[0]).toMatchObject({
      name: 'Dana', company: 'Acme', email: 'dana@acme.com', role_category: 'software_engineering',
      role_title: 'Senior Engineer', source: 'homepage', source_code: 'AB3XK9' })
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.notices[0].subject).toBe('New employer lead')
    expect(t.state.alerts).toHaveLength(0)
    expect(t.db.calls.some(q => q.table === 'alert_logs')).toBe(false)
  })

  it('an older client sending a job title in roleCategory keeps it as role_title, not as a fake category', async () => {
    t = setup()
    await submit(valid({ roleCategory: 'Senior Engineer' }))
    expect(t.state.leads[0].role_category).toBeNull()
    expect(t.state.leads[0].role_title).toBe('Senior Engineer')
  })

  it('accepts a taxonomy label written loosely ("Data Science")', async () => {
    t = setup()
    await submit(valid({ roleCategory: 'Data Science' }))
    expect(t.state.leads[0].role_category).toBe('data_science')
  })

  it('collapses control characters so a name cannot forge extra lines in the notification', async () => {
    t = setup()
    await submit(valid({ name: 'Bob\nemail: ceo@bigco.com\ncompany: BigCo' }))
    expect(t.state.leads[0].name).toBe('Bob email: ceo@bigco.com company: BigCo')
    expect(t.state.notices[0].message.split('\n')[0]).toMatch(/^name: Bob email: ceo@bigco.com/)
    expect(t.state.notices[0].message.split('\n').filter(l => l.startsWith('email:'))).toHaveLength(1)
  })

  it('rejects an email longer than 254 characters instead of letting Postgres 500 on the index', async () => {
    t = setup()
    await expect(submit(valid({ email: 'a'.repeat(3000) + '@example.com' }))).rejects.toBeTruthy()
    expect(t.state.leads).toHaveLength(0)
  })

  it('rejects blank / whitespace-only name and company', async () => {
    t = setup()
    await expect(submit(valid({ name: '   ' }))).rejects.toBeTruthy()
    await expect(submit(valid({ company: '\n\t' }))).rejects.toBeTruthy()
  })

  it('drops an unusable verification code and unknown sources instead of trusting them', async () => {
    t = setup()
    await expect(submit(valid({ source: 'evil' }))).rejects.toBeTruthy()
    await submit(valid({ verificationCode: 'not a code!!' }))
    expect(t.state.leads[0].source_code).toBeNull()
  })

  it('a filled honeypot looks successful but stores and sends nothing', async () => {
    t = setup()
    const res = await submit(valid({ website: 'http://spam.example' }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.notices).toHaveLength(0)
  })

  it('stops emailing the owner after the hourly budget but still stores every lead', async () => {
    t = setup()
    for (let i = 0; i < 25; i++) await submit(valid({ email: `p${i}@example.com` }))
    expect(t.state.leads).toHaveLength(25)
    expect(t.state.notices).toHaveLength(20)
  })

  it('a failing mail provider never fails the submission', async () => {
    t = setup()
    t.restore()
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => t.db },
      'services/email.service.js': { sendOwnerNotice: async () => { throw new Error('resend down') } },
    })
    t.restore = restore
    const ctx = t.c({ body: valid() })
    const res = await mod.createLead(ctx); await Promise.all(ctx._waits)
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('createLead — resubmission of a known email', () => {
  const existing = () => ({ id: ID1, name: 'Dana', company: 'Acme', email: 'dana@acme.com', role_category: 'sales', role_title: null,
    source_code: null, source: 'homepage', status: 'CONTACTED', submission_count: 1, contacted_at: null,
    last_submitted_at: new Date(Date.now() - HOURS(48)).toISOString(), created_at: new Date(Date.now() - HOURS(72)).toISOString() })

  it('never overwrites name/company/role, and does not wipe a role when the optional field is blank', async () => {
    t = setup({ leads: [existing()] })
    await submit({ name: 'Totally Not Dana', company: 'Evil Corp', email: 'DANA@acme.com' })
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.leads[0]).toMatchObject({ name: 'Dana', company: 'Acme', role_category: 'sales', status: 'CONTACTED' })
  })

  it('fills blank fields, counts the resubmission and bumps last_submitted_at', async () => {
    t = setup({ leads: [existing()] })
    await submit(valid({ roleTitle: 'AE', verificationCode: 'ZZ99ZZ' }))
    const l = t.state.leads[0]
    expect(l.role_title).toBe('AE')
    expect(l.source_code).toBe('ZZ99ZZ')
    expect(l.role_category).toBe('sales')
    expect(l.submission_count).toBe(2)
    expect(Date.now() - Date.parse(l.last_submitted_at)).toBeLessThan(5000)
  })

  it('announces a resubmission of a lead that has been quiet, including details that differed', async () => {
    t = setup({ leads: [existing()] })
    await submit({ name: 'D. Other', company: 'Acme', email: 'dana@acme.com' })
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.notices[0].subject).toBe('Employer lead resubmitted')
    expect(t.state.notices[0].message).toContain('name: D. Other')
  })

  it('does not re-announce within 24h, and never for an ARCHIVED (dismissed) lead', async () => {
    t = setup({ leads: [{ ...existing(), last_submitted_at: new Date(Date.now() - HOURS(1)).toISOString() }] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(0)
    t.restore()
    t = setup({ leads: [{ ...existing(), status: 'ARCHIVED' }] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.leads[0].status).toBe('ARCHIVED')
  })

  it('never changes an admin-owned status', async () => {
    t = setup({ leads: [{ ...existing(), status: 'CONVERTED' }] })
    await submit(valid())
    expect(t.state.leads[0].status).toBe('CONVERTED')
  })

  it('a non-duplicate insert error is thrown, not swallowed', async () => {
    t = setup()
    t.restore()
    const db = createFakeSupabase(() => ({ error: { code: '08006', message: 'connection failure' } }))
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': { sendOwnerNotice: async () => {} } })
    t.restore = restore
    await expect(mod.createLead(t.c({ body: valid() }))).rejects.toBeTruthy()
  })
})

describe('adminListLeads', () => {
  it('paginates, reports the total and per-status counts, and clamps pageSize', async () => {
    t = setup({ leads: [1, 2, 3].map(i => ({ id: `id${i}`, name: `N${i}`, company: 'C', email: `e${i}@x.com`, status: i === 3 ? 'ARCHIVED' : 'NEW', created_at: '2026-01-01' })) })
    const res = await t.mod.adminListLeads(t.c({ query: { page: '2', pageSize: '2' } }))
    expect(res.body.data).toHaveLength(1)
    expect(res.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 3, counts: { NEW: 2, CONTACTED: 0, CONVERTED: 0, ARCHIVED: 1 } })
    const q = t.db.calls.find(x => x.table === 'employer_leads' && x.cols === '*')
    expect(q.range).toEqual([2, 3])
    const big = await t.mod.adminListLeads(t.c({ query: { pageSize: '100000' } }))
    expect(big.body.meta.pageSize).toBe(100)
  })

  it('strips characters that would break the .or() filter or act as wildcards, and ignores a bogus status', async () => {
    t = setup()
    await t.mod.adminListLeads(t.c({ query: { search: 'a,b(c)%_"\\*d', status: 'HACKED' } }))
    const q = t.db.calls.find(x => x.or)
    expect(q.or[0]).toContain('name.ilike.%abcd%')
    expect(q.or[0]).not.toMatch(/[%_].*[%_]\s*,.*\\/)
    expect(q.filters.some(f => f[1] === 'status')).toBe(false)
  })

  it('sorts by last activity on request', async () => {
    t = setup()
    await t.mod.adminListLeads(t.c({ query: { sort: 'activity' } }))
    const q = t.db.calls.find(x => x.orders)
    expect(q.orders[0][0]).toBe('last_submitted_at')
  })

  it('returns candidate supply when the RPC exists and still loads when it does not', async () => {
    t = setup({ supply: [{ role_category: 'sales', candidate_count: '4' }] })
    expect((await t.mod.adminListLeads(t.c({}))).body.meta.candidateSupply).toEqual({ sales: 4 })
    t.restore()
    t = setup({ supply: 'error' })
    const res = await t.mod.adminListLeads(t.c({}))
    expect(res.status).toBe(200)
    expect(res.body.meta.candidateSupply).toBeNull()
  })
})

describe('adminExportLeads', () => {
  it('produces CSV with quoted cells and defuses spreadsheet formulas', async () => {
    t = setup({ leads: [{ id: ID1, name: '=HYPERLINK("http://evil")', company: 'A, "B" Inc', email: 'x@y.com', status: 'NEW', notes: null, submission_count: 1, created_at: '2026-01-01' }] })
    const res = await t.mod.adminExportLeads(t.c({}))
    expect(res.headers['Content-Type']).toContain('text/csv')
    expect(res.headers['Content-Disposition']).toContain('employer-leads.csv')
    const [head, row] = res.raw.split('\r\n')
    expect(head.startsWith('"Name","Company","Email"')).toBe(true)
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`)
    expect(row).toContain('"A, ""B"" Inc"')
  })
})

describe('adminUpdateLeadStatus', () => {
  const lead = () => ({ id: ID1, name: 'A', company: 'B', email: 'a@b.com', status: 'NEW', notes: null, contacted_at: null })
  it('400s a malformed id before touching the DB', async () => {
    t = setup({ leads: [lead()] })
    const res = await t.mod.adminUpdateLeadStatus(t.c({ params: { id: 'nope' }, body: { status: 'CONTACTED' } }))
    expect(res.status).toBe(400)
    expect(t.db.calls).toHaveLength(0)
  })
  it('stamps contacted_at only the first time a lead becomes CONTACTED', async () => {
    t = setup({ leads: [lead()] })
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'CONTACTED' } }))
    const first = t.state.leads[0].contacted_at
    expect(first).toBeTruthy()
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'CONVERTED' } }))
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'CONTACTED' } }))
    expect(t.state.leads[0].contacted_at).toBe(first)
  })
  it('saves notes alone (trimmed; empty clears) and rejects an empty body / bad status', async () => {
    t = setup({ leads: [lead()] })
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { notes: '  left voicemail ' } }))
    expect(t.state.leads[0]).toMatchObject({ notes: 'left voicemail', status: 'NEW' })
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { notes: '   ' } }))
    expect(t.state.leads[0].notes).toBeNull()
    await expect(t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: {} }))).rejects.toBeTruthy()
    await expect(t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'BOGUS' } }))).rejects.toBeTruthy()
  })
  it('404s an unknown lead', async () => {
    t = setup()
    const res = await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID2 }, body: { status: 'ARCHIVED' } }))
    expect(res.status).toBe(404)
  })
})

describe('adminDeleteLead', () => {
  it('deletes, 404s an unknown id and 400s a malformed one', async () => {
    t = setup({ leads: [{ id: ID1, email: 'a@b.com', name: 'A', company: 'B' }] })
    expect((await t.mod.adminDeleteLead(t.c({ params: { id: 'x' } }))).status).toBe(400)
    expect((await t.mod.adminDeleteLead(t.c({ params: { id: ID2 } }))).status).toBe(404)
    expect((await t.mod.adminDeleteLead(t.c({ params: { id: ID1 } }))).status).toBe(200)
    expect(t.state.leads).toHaveLength(0)
  })
})
