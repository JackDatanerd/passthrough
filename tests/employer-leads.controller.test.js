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

function setup({ leads = [], supply, kv = {}, suppressed = [], ackResult = true } = {}) {
  const state = { leads: leads.map(l => ({ ...l })), notices: [], alerts: [], acks: [], ackLinks: [], inserts: 0, kv,
    suppressed: new Set(suppressed), audit: [] }
  let seq = 0
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      const rows = state.leads
      const match = r => q.filters.every((f) => {
        const [op, col, val] = f
        if (op === 'eq') return r[col] === val
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
      const filtered = rows.filter(match)
      // PostgREST answers an offset past the end with 416 when a count was requested.
      if (q.range && q.range[0] > 0 && q.range[0] >= filtered.length && q.selectOpts?.count)
        return { error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
      return { data: filtered.slice(q.range ? q.range[0] : 0, q.range ? q.range[1] + 1 : undefined), count: filtered.length, error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      const h = q.filters.find(f => f[1] === 'email_hash')?.[2]
      if (q.op === 'upsert') { state.suppressed.add(q.values.email_hash); return { data: null, error: null } }
      // TEST FIX (fresh audit pass, Section 5): adminLiftSuppression chains
      // .select().maybeSingle() onto the delete to learn whether a row was
      // actually removed (real Postgres/Supabase returns the deleted row);
      // this used to always answer `data: null`, which made a real deletion
      // indistinguishable from "nothing to delete."
      if (q.op === 'delete') {
        const existed = state.suppressed.has(h)
        state.suppressed.delete(h)
        return { data: existed ? { email_hash: h } : null, error: null }
      }
      return { data: state.suppressed.has(h) ? { email_hash: h } : null, error: null }
    }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
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
    },
  })
  const env = { RATE_LIMIT_KV: { get: async k => state.kv[k] ?? null, put: async (k, v) => { state.kv[k] = v } },
    JWT_SECRET: SECRET, FRONTEND_URL: 'https://passthrough.dev' }
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

  it('drops an unusable verification code, and an unknown source falls back to the default instead of losing the lead', async () => {
    t = setup()
    await submit(valid({ source: 'evil', verificationCode: 'not a code!!' }))
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.leads[0].source).toBe('verification_page')
    expect(t.state.leads[0].source_code).toBeNull()
  })
  it('a non-string source (a number, an object) is also just dropped', async () => {
    t = setup()
    await submit(valid({ source: 42 }))
    await submit(valid({ email: 'b@acme.com', source: { $ne: 1 } }))
    expect(t.state.leads.map(l => l.source)).toEqual(['verification_page', 'verification_page'])
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

// BUG FIX (fresh audit pass, Section 5): a second collision on the same
// email — the row disappearing again, or another concurrent request winning
// the unique-email race a second time — used to just answer success having
// stored and sent nothing, silently dropping the submission. createLead now
// retries against the database's actual current state instead of giving up.
describe('createLead — resilience to a second collision on the same email', () => {
  it('merges into the lead instead of silently dropping the submission when the email races twice in a row', async () => {
    t = setup()
    t.restore()
    const freshExisting = {
      id: ID2, name: 'Dana', company: 'Acme', email: 'dana@acme.com', role_category: null, role_title: null,
      source_code: null, source: 'homepage', status: 'NEW', submission_count: 1, contacted_at: null,
      confirmed_at: new Date().toISOString(),   // already confirmed — no ack flow needed for this test
      updated_at: '2020-01-01T00:00:00.000Z',
      last_submitted_at: new Date(Date.now() - HOURS(48)).toISOString(),
      created_at: new Date(Date.now() - HOURS(72)).toISOString()
    }
    let step = 0
    const notices = []
    const db = createFakeSupabase(q => {
      if (q.table !== 'employer_leads') return { data: null, error: null }   // suppression check: not suppressed
      step++
      if (step === 1) return { error: { code: '23505', message: 'duplicate key' } }  // insert: email already taken
      if (step === 2) return { data: null, error: null }                             // select: gone (admin deleted it)
      if (step === 3) return { error: { code: '23505', message: 'duplicate key' } }   // retry insert: SOMEONE ELSE won this time
      if (step === 4) return { data: { ...freshExisting }, error: null }              // select: their row is now readable
      if (step === 5) return { data: { id: freshExisting.id }, error: null }          // merge update: succeeds
      throw new Error(`unexpected employer_leads call #${step}: ${q.op}`)
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerNotice: async (env, subject, message) => { notices.push({ subject, message }) },
        sendEmployerLeadAck: async () => true,
      },
    })
    t.restore = restore
    const ctx = t.c({ body: valid({ email: 'dana@acme.com' }) })
    const res = await mod.createLead(ctx)
    await Promise.all(ctx._waits)
    expect(res.body.success).toBe(true)
    // The submission was actually applied, not dropped: the owner gets the
    // resubmission notice the merge is supposed to produce...
    expect(notices).toHaveLength(1)
    expect(notices[0].subject).toBe('Employer lead resubmitted')
    // ...via exactly the insert/select/insert/select/update sequence above —
    // proving it reached the merge rather than bailing out early.
    expect(step).toBe(5)
  })

  it('gives up gracefully (still answers success) if every retry keeps racing', async () => {
    let step = 0
    const db = createFakeSupabase(q => {
      if (q.table !== 'employer_leads') return { data: null, error: null }
      step++
      // Every insert conflicts, every select comes back empty — a
      // pathological, unending race. Never throws, never hangs.
      if (q.op === 'insert') return { error: { code: '23505', message: 'duplicate key' } }
      return { data: null, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerNotice: async () => {}, sendEmployerLeadAck: async () => true },
    })
    t = setup()
    const ctx = t.c({ body: valid() })
    t.restore()
    t.restore = restore
    const res = await mod.createLead(ctx)
    expect(res.body.success).toBe(true)
    // Bounded: 3 attempts, insert then select each time.
    expect(step).toBe(6)
  })
})

// BUG FIX (fresh audit pass, Section 5): the hourly notice/ack budget used to
// be spent the instant a send was ATTEMPTED and never given back if the send
// then actually failed — a Resend outage during real traffic would burn the
// whole budget with nothing delivered, then keep starving legitimate leads
// for the rest of that hour even after the provider recovered.
describe('notice/ack budget: refunded when the send does not actually go out', () => {
  it('refunds the notice-budget slot on a thrown send failure, so the next lead is not starved', async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000)
    const key = `rl:leadnotice:${hourBucket}`
    t = setup({ kv: { [key]: JSON.stringify({ count: 19, refunds: 0 }) } })
    const { db, c, state } = t
    t.restore()
    let call = 0
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerNotice: async () => { call++; if (call === 1) throw new Error('Resend is down') },
        sendEmployerLeadAck: async () => true,
      },
    })
    t.restore = restore

    const ctx1 = c({ body: valid({ email: 'first@corp.com' }) })
    await mod.createLead(ctx1)
    await Promise.all(ctx1._waits)
    expect(JSON.parse(state.kv[key])).toMatchObject({ count: 19, refunds: 1 })   // back to where it started

    // Same hour, a genuinely new lead: still has budget BECAUSE of the
    // refund — proves this isn't just bookkeeping, a real notice goes out.
    const ctx2 = c({ body: valid({ email: 'second@corp.com' }) })
    await mod.createLead(ctx2)
    await Promise.all(ctx2._waits)
    expect(call).toBe(2)
    expect(JSON.parse(state.kv[key])).toMatchObject({ count: 20 })   // this one succeeded, so it stays spent
  })

  it('refunds the ack-budget slot when the acknowledgement does not actually go out', async () => {
    const hourBucket = Math.floor(Date.now() / 3_600_000)
    const key = `rl:leadack:${hourBucket}`
    t = setup({ kv: { [key]: JSON.stringify({ count: 29, refunds: 0 }) } })
    const { db, c, state } = t
    t.restore()
    let call = 0
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': {
        sendOwnerNotice: async () => {},
        sendEmployerLeadAck: async () => { call++; return call !== 1 },   // first attempt fails, rest succeed
      },
    })
    t.restore = restore

    const ctx1 = c({ body: valid({ email: 'third@corp.com' }) })
    await mod.createLead(ctx1)
    await Promise.all(ctx1._waits)
    expect(JSON.parse(state.kv[key])).toMatchObject({ count: 29, refunds: 1 })

    const ctx2 = c({ body: valid({ email: 'fourth@corp.com' }) })
    await mod.createLead(ctx2)
    await Promise.all(ctx2._waits)
    expect(call).toBe(2)
    expect(JSON.parse(state.kv[key])).toMatchObject({ count: 30 })
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
    await t.mod.adminListLeads(t.c({ query: { search: 'a,b(c)%"\\*d', status: 'HACKED' } }))
    const q = t.db.calls.find(x => x.or)
    expect(q.or[0]).toContain('name.ilike.%abcd%')
    expect(q.or[0]).not.toMatch(/\\/)
    expect(q.filters.some(f => f[1] === 'status')).toBe(false)
  })

  // `_` is an ilike single-char wildcard, so leaving it in can only widen a
  // match; stripping it made "john_doe@corp.com" unfindable.
  it('keeps underscores so an address containing one can be found', async () => {
    t = setup()
    await t.mod.adminListLeads(t.c({ query: { search: 'john_doe@corp.com' } }))
    expect(t.db.calls.find(x => x.or).or[0]).toContain('email.ilike.%john_doe@corp.com%')
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
    // Excel needs the byte-order mark to read the file as UTF-8.
    expect(res.raw.charCodeAt(0)).toBe(0xFEFF)
    const [head, row] = res.raw.slice(1).split('\r\n')
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
    await expect(t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: {} }))).rejects.toThrow(/Nothing to update/)
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

// ── Third pass (Section 5) ──────────────────────────────────────────────────

const mkLead = (over = {}) => ({
  id: ID1, name: 'A', company: 'B', email: 'a@b.com', status: 'NEW', notes: null, contacted_at: null,
  role_category: null, role_title: null, source: 'homepage', submission_count: 1,
  created_at: '2026-01-01T00:00:00.000Z', last_submitted_at: '2026-01-01T00:00:00.000Z', ...over,
})

describe('createLead — invisible characters and empty-looking values', () => {
  it('rejects a name or company made only of zero-width characters, and one with no letter or digit', async () => {
    t = setup()
    await expect(submit(valid({ name: '\u200b\u200b' }))).rejects.toBeTruthy()
    await expect(submit(valid({ company: '\u2060\ufeff' }))).rejects.toBeTruthy()
    await expect(submit(valid({ company: '---' }))).rejects.toBeTruthy()
    await expect(submit(valid({ name: '🙂' }))).rejects.toBeTruthy()
    expect(t.state.leads).toHaveLength(0)
  })
  it('removes bidi overrides and zero-width spaces but keeps ZWJ/ZWNJ that real scripts need', async () => {
    t = setup()
    await submit(valid({ name: 'Eve\u202Elin\u200bk', company: 'می\u200cخواهم Ltd' }))
    expect(t.state.leads[0].name).toBe('Evelink')
    expect(t.state.leads[0].company).toBe('می\u200cخواهم Ltd')
  })
  it('accepts null for the optional fields (a client that serialises "empty" as null)', async () => {
    t = setup()
    await submit(valid({ roleCategory: null, roleTitle: null, verificationCode: null, website: null }))
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('createLead — acknowledgement to the submitter', () => {
  it('sends exactly one, for a brand-new lead, with the field label', async () => {
    t = setup()
    await submit(valid({ roleCategory: 'data_science' }))
    expect(t.state.acks).toEqual([{ to: 'dana@acme.com', name: 'Dana', field: 'Data Science' }])
  })
  it('carries a signed confirm link and a signed remove link that verify only for their own purpose and address', async () => {
    t = setup()
    await submit(valid())
    const { confirmUrl, removeUrl } = t.state.ackLinks[0]
    expect(confirmUrl).toMatch(/^https:\/\/passthrough\.dev\/employer\/confirm\?token=[\w.-]+$/)
    expect(removeUrl).toMatch(/^https:\/\/passthrough\.dev\/employer\/remove\?token=[\w.-]+$/)
    const { verifyLeadToken } = await import('../src/lib/leadTokens.js')
    const confirmTok = new URL(confirmUrl).searchParams.get('token')
    const removeTok = new URL(removeUrl).searchParams.get('token')
    expect(await verifyLeadToken(SECRET, 'confirm', confirmTok)).toBe('dana@acme.com')
    expect(await verifyLeadToken(SECRET, 'remove', removeTok)).toBe('dana@acme.com')
    expect(await verifyLeadToken(SECRET, 'remove', confirmTok)).toBeNull()   // purposes are not interchangeable
  })
  it('never re-sends for a CONFIRMED lead resubmitting, or for a honeypot hit', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', confirmed_at: '2026-02-01T00:00:00.000Z', last_submitted_at: new Date(Date.now() - HOURS(30)).toISOString() })] })
    await submit(valid())
    await submit(valid({ email: 'bot@x.com', website: 'http://spam' }))
    expect(t.state.acks).toHaveLength(0)
  })
  it('re-sends the confirmation when an UNCONFIRMED lead resubmits — but not for a dismissed (ARCHIVED) one', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(1)
    t.restore()
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', status: 'ARCHIVED' })] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(0)
  })
  it('has its own hourly budget, and a failing send never fails the submission', async () => {
    t = setup({ kv: { [`rl:leadack:${Math.floor(Date.now() / 3_600_000)}`]: '30' } })
    const res = await submit(valid())
    expect(res.body.success).toBe(true)
    expect(t.state.acks).toHaveLength(0)
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('adminListLeads — field filter, ordering, stale pages', () => {
  it('filters by field, by "none" (uncategorised), and ignores a value outside the taxonomy', async () => {
    t = setup({ leads: [mkLead({ role_category: 'sales' }), mkLead({ id: ID2, email: 'b@b.com' })] })
    let res = await t.mod.adminListLeads(t.c({ query: { field: 'sales' } }))
    expect(res.body.data.map(l => l.email)).toEqual(['a@b.com'])
    res = await t.mod.adminListLeads(t.c({ query: { field: 'none' } }))
    expect(res.body.data.map(l => l.email)).toEqual(['b@b.com'])
    t.db.calls.length = 0
    await t.mod.adminListLeads(t.c({ query: { field: 'nonsense' } }))
    expect(t.db.calls.some(q => q.filters.some(f => f[1] === 'role_category'))).toBe(false)
  })
  // FEATURE GAP CLOSED (fresh audit pass, Section 5): source/source_code were
  // captured meticulously and reached the CSV export, but there was no way to
  // filter or count by source anywhere in the live admin list.
  it('filters by source, ignores a value outside the whitelist, and accepts "manual" (not in the public LEAD_SOURCES)', async () => {
    t = setup({ leads: [
      mkLead({ source: 'homepage' }),
      mkLead({ id: ID2, email: 'b@b.com', source: 'verification_page' }),
      mkLead({ id: 'gen-manual', email: 'c@b.com', source: 'manual' }),
    ] })
    let res = await t.mod.adminListLeads(t.c({ query: { source: 'homepage' } }))
    expect(res.body.data.map(l => l.email)).toEqual(['a@b.com'])
    res = await t.mod.adminListLeads(t.c({ query: { source: 'manual' } }))
    expect(res.body.data.map(l => l.email)).toEqual(['c@b.com'])
    t.db.calls.length = 0
    await t.mod.adminListLeads(t.c({ query: { source: 'not-a-real-source' } }))
    const mainQuery = t.db.calls.find(x => x.selectOpts?.count === 'exact' && !x.selectOpts.head)
    expect(mainQuery.filters.some(f => f[1] === 'source')).toBe(false)
  })
  it('reports per-source counts unaffected by the current filters', async () => {
    t = setup({ leads: [
      mkLead({ source: 'homepage' }),
      mkLead({ id: ID2, email: 'b@b.com', source: 'homepage' }),
      mkLead({ id: 'gen-manual', email: 'c@b.com', source: 'manual' }),
    ] })
    const res = await t.mod.adminListLeads(t.c({ query: { source: 'manual' } }))
    expect(res.body.meta.sourceCounts).toMatchObject({ homepage: 2, verification_page: 0, manual: 1 })
  })
  it('orders by id last so rows on a page boundary have one stable position', async () => {
    t = setup()
    await t.mod.adminListLeads(t.c({}))
    const q = t.db.calls.find(x => x.selectOpts?.count === 'exact' && !x.selectOpts.head)
    expect(q.orders.map(o => o[0])).toEqual(['created_at', 'id'])
  })
  it('a page past the end is an empty page with the real total, not an error', async () => {
    t = setup({ leads: [mkLead(), mkLead({ id: ID2, email: 'b@b.com' })] })
    const res = await t.mod.adminListLeads(t.c({ query: { page: '9' } }))
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(res.body.meta).toMatchObject({ page: 9, total: 2 })
  })
})

describe('adminExportLeads — field filter', () => {
  it('exports only the selected field', async () => {
    t = setup({ leads: [mkLead({ role_category: 'sales' }), mkLead({ id: ID2, email: 'b@b.com', role_category: 'legal' })] })
    const res = await t.mod.adminExportLeads(t.c({ query: { field: 'legal' } }))
    expect(res.raw).toContain('b@b.com')
    expect(res.raw).not.toContain('a@b.com')
  })
})

describe('adminCreateLead', () => {
  const body = (over = {}) => ({ name: ' Sam  Ng ', company: 'Initech', email: 'SAM@Initech.com', roleCategory: 'finance', ...over })
  it('stores a manual lead cleaned like a public one, with no owner notice or acknowledgement', async () => {
    t = setup()
    const res = await t.mod.adminCreateLead(t.c({ body: body({ notes: ' met at conf ' }) }))
    expect(res.status).toBe(201)
    expect(t.state.leads[0]).toMatchObject({ name: 'Sam Ng', email: 'sam@initech.com', source: 'manual', role_category: 'finance', notes: 'met at conf', status: 'NEW' })
    expect(res.body.data.email).toBe('sam@initech.com')
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.acks).toHaveLength(0)
  })
  it('stamps contacted_at when created as CONTACTED', async () => {
    t = setup()
    await t.mod.adminCreateLead(t.c({ body: body({ status: 'CONTACTED' }) }))
    expect(t.state.leads[0].contacted_at).toBeTruthy()
  })
  it('409s a duplicate email and rejects bad input', async () => {
    t = setup({ leads: [mkLead({ email: 'sam@initech.com' })] })
    const res = await t.mod.adminCreateLead(t.c({ body: body() }))
    expect(res.status).toBe(409)
    await expect(t.mod.adminCreateLead(t.c({ body: body({ email: 'nope' }) }))).rejects.toBeTruthy()
    await expect(t.mod.adminCreateLead(t.c({ body: body({ roleCategory: 'astronaut' }) }))).rejects.toBeTruthy()
  })
})

describe('adminUpdateLeadStatus — editing fields', () => {
  it('corrects name/company and categorises a lead; a blank title clears it; email is not editable', async () => {
    t = setup({ leads: [mkLead({ role_title: 'Old' })] })
    const res = await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 },
      body: { name: ' New  Name ', company: 'Newco', roleCategory: 'sales', roleTitle: '', email: 'hijack@x.com' } }))
    expect(res.status).toBe(200)
    expect(t.state.leads[0]).toMatchObject({ name: 'New Name', company: 'Newco', role_category: 'sales', role_title: null, email: 'a@b.com' })
  })
  it('null clears the category; an unknown category and a blank name are rejected', async () => {
    t = setup({ leads: [mkLead({ role_category: 'sales' })] })
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { roleCategory: null } }))
    expect(t.state.leads[0].role_category).toBeNull()
    await expect(t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { roleCategory: 'astronaut' } }))).rejects.toBeTruthy()
    await expect(t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { name: '  ' } }))).rejects.toBeTruthy()
  })
})

describe('adminBulkUpdateLeads', () => {
  const two = () => [mkLead(), mkLead({ id: ID2, email: 'b@b.com', contacted_at: '2026-02-02T00:00:00.000Z' })]
  it('sets a status on the chosen leads only, and stamps contacted_at only where it was empty', async () => {
    t = setup({ leads: [...two(), mkLead({ id: '33333333-3333-4333-8333-333333333333', email: 'c@b.com' })] })
    const res = await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1, ID2], action: 'setStatus', status: 'CONTACTED' } }))
    expect(res.body).toEqual({ success: true, affected: 2 })
    const [a, b, other] = t.state.leads
    expect([a.status, b.status, other.status]).toEqual(['CONTACTED', 'CONTACTED', 'NEW'])
    expect(a.contacted_at).toBeTruthy()
    expect(b.contacted_at).toBe('2026-02-02T00:00:00.000Z')
    expect(other.contacted_at).toBeNull()
  })
  it('deletes the chosen leads', async () => {
    t = setup({ leads: two() })
    const res = await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1], action: 'delete' } }))
    expect(res.body.affected).toBe(1)
    expect(t.state.leads.map(l => l.id)).toEqual([ID2])
  })
  it('validates ids, action, the status requirement and the batch size before touching the DB', async () => {
    t = setup({ leads: two() })
    for (const body of [
      { ids: ['nope'], action: 'delete' }, { ids: [], action: 'delete' }, { ids: [ID1], action: 'explode' },
      { ids: [ID1], action: 'setStatus' }, { ids: [ID1], action: 'setStatus', status: 'BOGUS' },
      { ids: Array.from({ length: 101 }, () => ID1), action: 'delete' },
    ]) await expect(t.mod.adminBulkUpdateLeads(t.c({ body }))).rejects.toBeTruthy()
    expect(t.db.calls).toHaveLength(0)
  })
})

// ── Fix round: address confirmation, one-click removal, audit trail ──────────

const tokenFor = async (purpose, email) => (await import('../src/lib/leadTokens.js')).signLeadToken(SECRET, purpose, email)
const postToken = (fn, token) => fn(t.c({ body: { token } }))

describe('createLead — do-not-contact list', () => {
  it('silently ignores a suppressed address: same success response, nothing stored, nobody emailed', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    const res = await submit(valid())
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.acks).toHaveLength(0)
  })
  it('matches case-insensitively (the address is lowercased before hashing)', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    await submit(valid({ email: 'DANA@ACME.COM' }))
    expect(t.state.leads).toHaveLength(0)
  })
  it('a deployment that has not run migration 0034 yet still captures the lead (fails open, loudly) instead of 500ing the form', async () => {
    t = setup()
    t.restore()
    const inner = createFakeSupabase(q => {
      if (q.table === 'employer_lead_suppressions') return { error: { code: '42P01', message: 'relation does not exist' } }
      if (q.table === 'employer_leads' && q.op === 'insert') return { data: null, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => inner }, 'services/email.service.js': { sendOwnerNotice: async () => {}, sendEmployerLeadAck: async () => true } })
    t.restore = restore
    const ctx = t.c({ body: valid() })
    const res = await mod.createLead(ctx); await Promise.all(ctx._waits)
    expect(res.body.success).toBe(true)
    expect(inner.calls.some(q => q.table === 'employer_leads' && q.op === 'insert')).toBe(true)
  })
  it('a real (non-missing-table) lookup error is thrown, not treated as "not suppressed"', async () => {
    t = setup()
    t.restore()
    const inner = createFakeSupabase(q => q.table === 'employer_lead_suppressions' ? { error: { code: '08006', message: 'connection failure' } } : undefined)
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => inner }, 'services/email.service.js': {} })
    t.restore = restore
    await expect(mod.createLead(t.c({ body: valid() }))).rejects.toBeTruthy()
  })
  it('does not affect other addresses', async () => {
    t = setup({ suppressed: [sha('someone-else@acme.com')] })
    await submit(valid())
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('confirmLead', () => {
  it('marks the lead confirmed, tells the owner, and reports the status', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const ctx = t.c({ body: { token: await tokenFor('confirm', 'dana@acme.com') } })
    const res = await t.mod.confirmLead(ctx); await Promise.all(ctx._waits)
    expect(res.body).toMatchObject({ success: true, status: 'confirmed' })
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(t.state.notices.map(n => n.subject)).toEqual(['Employer lead confirmed'])
  })
  it('is idempotent: a second click changes nothing and says so', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', confirmed_at: '2026-02-01T00:00:00.000Z' })] })
    const res = await postToken(t.mod.confirmLead, await tokenFor('confirm', 'dana@acme.com'))
    expect(res.body).toMatchObject({ success: true, status: 'already' })
    expect(t.state.leads[0].confirmed_at).toBe('2026-02-01T00:00:00.000Z')
    expect(t.state.notices).toHaveLength(0)
  })
  // BUG FIX (fresh audit pass, Section 5): the update used to run
  // `.is('confirmed_at', null)` with no check on whether it actually matched a
  // row, so a request that lost this exact race (read confirmed_at=null, but
  // another request confirmed the lead first) still unconditionally told the
  // owner. Simulated the same way the createLead race tests above do — a
  // custom step sequence, since a genuine concurrent DB race isn't
  // reproducible against an in-memory fake.
  it('does not notify the owner twice when two confirm requests race (loses to a concurrent confirm)', async () => {
    const lead = mkLead({ email: 'dana@acme.com', confirmed_at: null })
    let step = 0
    const notices = []
    const db = createFakeSupabase(q => {
      step++
      if (step === 1) return { data: { ...lead }, error: null }   // read: still unconfirmed
      if (step === 2) return { data: null, error: null }          // update: 0 rows — someone else won the race
      throw new Error(`unexpected call #${step}: ${q.op}`)
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerNotice: async (env, subject, message) => { notices.push({ subject, message }) } },
    })
    const ctx = { env: { JWT_SECRET: SECRET }, executionCtx: { waitUntil: p => p }, req: { json: async () => ({ token: await tokenFor('confirm', 'dana@acme.com') }) }, json: (body, status = 200) => ({ body, status }) }
    const res = await mod.confirmLead(ctx)
    restore()
    expect(res.body).toMatchObject({ success: true, status: 'already' })
    expect(notices).toHaveLength(0)   // the winner's own request sends the one real notice; this is the loser
    expect(step).toBe(2)
  })
  it('says not_found for an address with no lead (deleted / removed) rather than claiming a confirmation', async () => {
    t = setup()
    const res = await postToken(t.mod.confirmLead, await tokenFor('confirm', 'gone@acme.com'))
    expect(res.body).toMatchObject({ success: true, status: 'not_found' })
  })
  it('rejects a removal token, a forged token, garbage and a token signed with another secret', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const { signLeadToken } = await import('../src/lib/leadTokens.js')
    for (const bad of [
      await tokenFor('remove', 'dana@acme.com'),
      (await tokenFor('confirm', 'dana@acme.com')).slice(0, -2) + 'AA',
      await signLeadToken('another-secret-'.padEnd(40, 'y'), 'confirm', 'dana@acme.com'),
      'not-a-token-at-all',
    ]) {
      const res = await postToken(t.mod.confirmLead, bad)
      expect(res.status).toBe(400)
    }
    expect(t.state.leads[0].confirmed_at).toBeUndefined()
  })
  it('a token for one address cannot confirm another', async () => {
    t = setup({ leads: [mkLead({ email: 'victim@acme.com' })] })
    const res = await postToken(t.mod.confirmLead, await tokenFor('confirm', 'attacker@evil.com'))
    expect(res.body.status).toBe('not_found')
    expect(t.state.leads[0].confirmed_at).toBeUndefined()
  })
  it('a missing or oversize token is a validation error, not a crash', async () => {
    t = setup()
    await expect(postToken(t.mod.confirmLead, undefined)).rejects.toBeTruthy()
    await expect(postToken(t.mod.confirmLead, 'a'.repeat(5000))).rejects.toBeTruthy()
  })
})

describe('removeLead', () => {
  it('deletes the lead AND records the do-not-contact hash (hash first, so a half-failure retries safely)', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const res = await postToken(t.mod.removeLead, await tokenFor('remove', 'dana@acme.com'))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
    const ops = t.db.calls.map(q => `${q.table}:${q.op}`)
    expect(ops.indexOf('employer_lead_suppressions:upsert')).toBeLessThan(ops.indexOf('employer_leads:delete'))
  })
  it('works even when the lead is already gone (an old email, an admin delete), and is repeatable', async () => {
    t = setup()
    const token = await tokenFor('remove', 'dana@acme.com')
    expect((await postToken(t.mod.removeLead, token)).body.success).toBe(true)
    expect((await postToken(t.mod.removeLead, token)).body.success).toBe(true)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
  })
  it('after removal, resubmitting the form does not bring them back', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    await postToken(t.mod.removeLead, await tokenFor('remove', 'dana@acme.com'))
    await submit(valid())
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.acks).toHaveLength(0)
  })
  it('rejects a confirm token and a forged one, removing nothing', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    expect((await postToken(t.mod.removeLead, await tokenFor('confirm', 'dana@acme.com'))).status).toBe(400)
    expect((await postToken(t.mod.removeLead, 'abcdefghij.klmnopqrst.uvwxyz')).status).toBe(400)
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.suppressed.size).toBe(0)
  })
})

// FEATURE GAP CLOSED (fresh audit pass, Section 5): the only way an admin
// could learn an address was suppressed used to be trying to re-add it via
// adminCreateLead and reading the 409. A browsable list isn't meaningful —
// only a SHA-256 hash is stored, never the address — so these are a
// check-one-address lookup and a lift-in-place action instead.
describe('adminCheckSuppression', () => {
  it('reports a suppressed address with when it was suppressed', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    const res = await t.mod.adminCheckSuppression(t.c({ body: { email: 'DANA@Acme.com' } }))
    expect(res.body).toMatchObject({ success: true, data: { suppressed: true } })
  })
  it('reports an address that is not suppressed', async () => {
    t = setup()
    const res = await t.mod.adminCheckSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    expect(res.body).toMatchObject({ success: true, data: { suppressed: false, since: null } })
  })
  it('rejects a malformed email before touching the DB', async () => {
    t = setup()
    await expect(t.mod.adminCheckSuppression(t.c({ body: { email: 'not-an-email' } }))).rejects.toBeTruthy()
  })
})

describe('adminLiftSuppression', () => {
  it('lifts a suppression and audits it by hash, never by address', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    const res = await t.mod.adminLiftSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    expect(res.body).toMatchObject({ success: true })
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(false)
    expect(t.state.audit).toHaveLength(1)
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.suppression_lift', target_id: sha('dana@acme.com') })
    expect(JSON.stringify(t.state.audit[0])).not.toContain('dana@acme.com')
  })
  it('404s an address that is not on the list, and lifts nothing', async () => {
    t = setup()
    const res = await t.mod.adminLiftSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    expect(res.status).toBe(404)
    expect(t.state.audit).toHaveLength(0)
  })
  it('after lifting, the address can be added again and the public form works for it', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    await t.mod.adminLiftSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    const res = await submit(valid({ email: 'dana@acme.com' }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(1)
  })
})

describe('adminCreateLead — confirmation and do-not-contact', () => {
  const body = (over = {}) => ({ name: 'Ann', company: 'Co', email: 'ann@co.com', ...over })
  it('an admin-entered lead is stored as already confirmed', async () => {
    t = setup()
    const res = await t.mod.adminCreateLead(t.c({ body: body() }))
    expect(res.status).toBe(201)
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(res.body.data.confirmedAt).toBeTruthy()
  })
  it('refuses an address on the do-not-contact list with a machine-readable code', async () => {
    t = setup({ suppressed: [sha('ann@co.com')] })
    const res = await t.mod.adminCreateLead(t.c({ body: body() }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('REMOVAL_REQUESTED')
    expect(t.state.leads).toHaveLength(0)
  })
  it('adds it anyway on an explicit override, and lifts the suppression', async () => {
    t = setup({ suppressed: [sha('ann@co.com')] })
    const res = await t.mod.adminCreateLead(t.c({ body: body({ overrideRemoval: true }) }))
    expect(res.status).toBe(201)
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.create', detail: { liftedRemoval: true } })
  })
})

describe('adminRequestConfirmation', () => {
  it('sends the confirmation to an unconfirmed lead (bypassing only the public form budget) and audits it', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', role_category: 'legal' })], kv: { [`rl:leadack:${Math.floor(Date.now() / 3_600_000)}`]: '30' } })
    const res = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(res.body.success).toBe(true)
    expect(t.state.acks).toEqual([{ to: 'dana@acme.com', name: 'A', field: 'Legal' }])
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.request_confirmation', target_id: ID1, detail: { sent: true } })
  })
  it('409s an already-confirmed lead, 404s an unknown one, 400s a bad id', async () => {
    t = setup({ leads: [mkLead({ confirmed_at: '2026-02-01T00:00:00.000Z' })] })
    expect((await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))).status).toBe(409)
    expect((await t.mod.adminRequestConfirmation(t.c({ params: { id: ID2 } }))).status).toBe(404)
    expect((await t.mod.adminRequestConfirmation(t.c({ params: { id: 'nope' } }))).status).toBe(400)
    expect(t.state.acks).toHaveLength(0)
  })
  it('reports a throttled / failed send honestly instead of claiming success', async () => {
    t = setup({ leads: [mkLead()], ackResult: false })
    const res = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(429)
    expect(res.body.success).toBe(false)
  })
})

describe('adminListLeads / export — confirmation state', () => {
  const mixed = () => [
    mkLead({ email: 'yes@x.com', confirmed_at: '2026-02-01T00:00:00.000Z' }),
    mkLead({ id: ID2, email: 'no@x.com' }),
  ]
  it('filters by confirmed=yes / confirmed=no and ignores anything else', async () => {
    t = setup({ leads: mixed() })
    expect((await t.mod.adminListLeads(t.c({ query: { confirmed: 'yes' } }))).body.data.map(l => l.email)).toEqual(['yes@x.com'])
    expect((await t.mod.adminListLeads(t.c({ query: { confirmed: 'no' } }))).body.data.map(l => l.email)).toEqual(['no@x.com'])
    expect((await t.mod.adminListLeads(t.c({ query: { confirmed: 'maybe' } }))).body.data).toHaveLength(2)
  })
  it('reports how many leads are unconfirmed, whatever filter is active', async () => {
    t = setup({ leads: mixed() })
    const res = await t.mod.adminListLeads(t.c({ query: { confirmed: 'yes' } }))
    expect(res.body.meta.unconfirmed).toBe(1)
  })
  it('the CSV has an "Email confirmed at" column', async () => {
    t = setup({ leads: mixed() })
    const res = await t.mod.adminExportLeads(t.c({}))
    expect(res.raw).toContain('"Email confirmed at"')
    expect(res.raw).toContain('2026-02-01T00:00:00.000Z')
  })
})

describe('admin audit trail', () => {
  it('records update / delete / bulk / export with ids, counts and field NAMES — never the values typed', async () => {
    t = setup({ leads: [mkLead(), mkLead({ id: ID2, email: 'b@b.com' })] })
    await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'CONTACTED', notes: 'secret note', name: 'New Name' } }))
    await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1, ID2], action: 'setStatus', status: 'ARCHIVED' } }))
    await t.mod.adminExportLeads(t.c({ query: { search: 'someone@corp.com', status: 'NEW' } }))
    await t.mod.adminDeleteLead(t.c({ params: { id: ID2 } }))
    await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1], action: 'delete' } }))
    expect(t.state.audit.map(a => a.action)).toEqual(['lead.update', 'lead.bulk_status', 'lead.export', 'lead.delete', 'lead.bulk_delete'])
    expect(t.state.audit.every(a => a.actor_id === 'admin-1')).toBe(true)
    expect(t.state.audit[0].detail).toEqual({ fields: ['status', 'notes', 'name'], status: 'CONTACTED' })
    expect(t.state.audit[1].detail).toEqual({ status: 'ARCHIVED', ids: [ID1, ID2] })
    expect(t.state.audit[2].detail).toMatchObject({ searched: true, filters: { status: 'NEW' } })
    const blob = JSON.stringify(t.state.audit)
    for (const secret of ['secret note', 'New Name', 'someone@corp.com', 'b@b.com']) expect(blob).not.toContain(secret)
  })
  it('an audit-write failure never fails the admin action that already happened', async () => {
    t = setup({ leads: [mkLead()] })
    t.restore()
    const inner = createFakeSupabase(q => {
      if (q.table === 'admin_audit_log') return { error: { message: 'audit table missing' } }
      if (q.table === 'employer_leads' && q.op === 'delete') return { data: { id: ID1 }, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => inner }, 'services/email.service.js': {} })
    t.restore = restore
    const res = await mod.adminDeleteLead(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(200)
  })
})
