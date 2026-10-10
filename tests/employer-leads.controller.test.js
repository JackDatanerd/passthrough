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
        if (liftError) return { data: null, error: liftError }
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

  it('does not re-announce within 24h; an ARCHIVED (dismissed) lead is never reopened and gets the archived notice instead', async () => {
    t = setup({ leads: [{ ...existing(), last_notice_at: new Date(Date.now() - HOURS(1)).toISOString() }] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(0)
    t.restore()
    t = setup({ leads: [{ ...existing(), status: 'ARCHIVED' }] })
    await submit(valid())
    expect(t.state.notices.map(n => n.subject)).toEqual(['Archived employer lead resubmitted'])   // round 10; see employer-leads.round10.test.js
    expect(t.state.leads[0].status).toBe('ARCHIVED')
    expect(t.state.acks).toHaveLength(0)
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
    // (+1: the resubmission notice is recorded on the lead as last_notice_at once it really went out)
    expect(step).toBe(6)
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
    await Promise.all(ctx._waits)   // round 8: a duplicate is settled after the response
    expect(res.body.success).toBe(true)
    // Bounded: the one insert the response waits for, then 3 background passes of select + insert.
    expect(step).toBe(7)
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
    const key = 'rl:leadnotice:budget'
    t = setup({ kv: { [key]: JSON.stringify({ count: 19, windowStart: Date.now(), refunds: 0 }) } })
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
    const key = 'rl:leadack:budget'
    t = setup({ kv: { [key]: JSON.stringify({ count: 29, windowStart: Date.now(), refunds: 0 }) } })
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

// BUG FIX (fresh audit pass, Section 5): the export used to page with
// offset-based `.range()`, re-evaluating the whole filtered/sorted result on
// every request. A lead deleted from earlier in the sort order shifts every
// later row up by one position, so the NEXT chunk's offset starts one row too
// late — silently dropping a lead that was never exported. Fixed with a
// keyset cursor (see applyCursor/cursorFor), which has no notion of position.
// setup()'s shared fake doesn't actually apply `.or()` or `.limit()` (small
// fixtures never needed it to), so this uses its own resolver that does,
// specifically so this regression can't come back unnoticed.
describe('adminExportLeads — chunked pagination survives a concurrent delete', () => {
  function makeChunkedDb(rows) {
    const splitTopLevel = (s) => {
      const out = []; let depth = 0; let cur = ''
      for (const ch of s) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
      }
      if (cur) out.push(cur)
      return out
    }
    const evalClause = (clause, row) => {
      if (clause.startsWith('and(')) return splitTopLevel(clause.slice(4, -1)).every(c => evalClause(c, row))
      const [col, op, ...rest] = clause.split('.')
      const val = rest.join('.')
      return op === 'lt' ? row[col] < val : op === 'eq' ? row[col] === val : true
    }
    const cmp = (orders) => (a, b) => {
      for (const [col, opts] of orders) {
        if (a[col] === b[col]) continue
        return (a[col] < b[col] ? -1 : 1) * (opts?.ascending ? 1 : -1)
      }
      return 0
    }
    return createFakeSupabase(q => {
      if (q.table !== 'employer_leads') return undefined
      let filtered = rows.filter(r => (q.filters || []).every(([op, col, val]) => op === 'eq' ? r[col] === val : true))
      if (q.selectOpts?.head) return { count: filtered.length, error: null }
      if (q.or) filtered = filtered.filter(r => q.or.every(expr => splitTopLevel(expr).some(c => evalClause(c, r))))
      filtered = filtered.slice().sort(cmp(q.orders))
      return { data: (q.limit != null ? filtered.slice(0, q.limit) : filtered).map(r => ({ ...r })), error: null }
    })
  }

  function makeLeads(n) {
    const rows = []
    for (let i = 0; i < n; i++) {
      const id = `id-${String(i).padStart(6, '0')}`
      // Strictly increasing so default sort (created_at desc, id desc) gives
      // every row a distinct position — newest (highest i) exported first.
      rows.push({
        id, name: `Lead ${i}`, company: 'Acme', email: `lead${i}@corp.com`,
        status: 'NEW', notes: null, submission_count: 1,
        created_at: new Date(2026, 0, 1, 0, 0, i).toISOString()
      })
    }
    return rows
  }

  it('exports every row exactly once across multiple chunks', async () => {
    const rows = makeLeads(2200)   // > 2 * EXPORT_CHUNK (1000), forces 3 requests
    const db = makeChunkedDb(rows)
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'lib/adminAudit.js': { logAdminAction: async () => {} }
    })
    const res = await mod.adminExportLeads({
      env: {}, get: () => ({ id: 'admin-1', role: 'ADMIN' }),
      req: { query: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }),
      body: drainBody
    })
    const lines = res.raw.slice(1).split('\r\n').filter(Boolean)
    expect(lines.length).toBe(rows.length + 1)   // header + every row, no more, no less
    const emails = new Set(lines.slice(1).map(l => l.match(/lead\d+@corp\.com/)[0]))
    expect(emails.size).toBe(rows.length)   // no duplicates
    for (const r of rows) expect(emails.has(r.email)).toBe(true)   // nothing missing
    restore()
  })

  it('does not skip a row when a lead earlier in the sort order is deleted mid-export', async () => {
    const rows = makeLeads(1500)   // > EXPORT_CHUNK: guarantees at least 2 requests
    const db = makeChunkedDb(rows)
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'lib/adminAudit.js': { logAdminAction: async () => {} }
    })
    // Default sort is created_at desc: the row with the HIGHEST index sorts
    // FIRST. Delete one of those (id-001499, the very first row exported)
    // right after the first chunk lands — exactly the case that shifted
    // everything under the old offset-based `.range()` and dropped a row.
    let firstChunkSeen = false
    const origFrom = db.from.bind(db)
    db.from = (table) => {
      const api = origFrom(table)
      const origThen = api.then.bind(api)
      api.then = (resolve, reject) => origThen((result) => {
        if (!firstChunkSeen && table === 'employer_leads' && result?.data?.length) {
          firstChunkSeen = true
          const idx = rows.findIndex(r => r.id === 'id-001499')
          if (idx !== -1) rows.splice(idx, 1)
        }
        return resolve(result)
      }, reject)
      return api
    }
    const res = await mod.adminExportLeads({
      env: {}, get: () => ({ id: 'admin-1', role: 'ADMIN' }),
      req: { query: () => undefined }, json: (b, s = 200) => ({ body: b, status: s }),
      body: drainBody
    })
    const lines = res.raw.slice(1).split('\r\n').filter(Boolean)
    const emails = new Set(lines.slice(1).map(l => l.match(/lead\d+@corp\.com/)[0]))
    // Every row that was NOT the one deleted mid-export must still be present.
    for (const r of rows) expect(emails.has(r.email)).toBe(true)
    restore()
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
    t = setup({ kv: { 'rl:leadack:budget': JSON.stringify({ count: 30, windowStart: Date.now(), refunds: 0 }) } })
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
  it('corrects name/company and categorises a lead; a blank title clears it', async () => {
    t = setup({ leads: [mkLead({ role_title: 'Old' })] })
    const res = await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 },
      body: { name: ' New  Name ', company: 'Newco', roleCategory: 'sales', roleTitle: '' } }))
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
  // BUG FIX (fresh audit pass, Section 5, second re-pass): notifyOwner used to
  // fire unconditionally here, including for a lead the admin already
  // ARCHIVED — mergeIntoExistingLead already treats ARCHIVED as "don't
  // re-bother the owner about this one" for a resubmission; confirming an
  // address is the same category of event. The confirmation itself still
  // goes through (the address genuinely is confirmed either way) — only the
  // owner notice is suppressed.
  it('still confirms an ARCHIVED lead but does not notify the owner about it', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', status: 'ARCHIVED' })] })
    const ctx = t.c({ body: { token: await tokenFor('confirm', 'dana@acme.com') } })
    const res = await t.mod.confirmLead(ctx); await Promise.all(ctx._waits)
    expect(res.body).toMatchObject({ success: true, status: 'confirmed' })
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(t.state.notices).toHaveLength(0)
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

// FEATURE GAP CLOSED (fresh audit pass, Section 5): the write side of the
// do-not-contact list. Before this, only the public remove link (removeLead,
// requiring the person's own signed token) could ever write a suppression —
// an admin honoring the same request through any other channel (a reply, a
// call) could only delete the lead, which records no suppression at all.
describe('adminAddSuppression', () => {
  it('suppresses an address with no existing lead — a pre-emptive block', async () => {
    t = setup()
    const res = await t.mod.adminAddSuppression(t.c({ body: { email: 'spammer@bad.com' } }))
    expect(res.body).toMatchObject({ success: true, data: { leadsRemoved: 0 } })
    expect(t.state.suppressed.has(sha('spammer@bad.com'))).toBe(true)
  })
  it('suppresses an address AND removes its existing lead, same order/effect as the public remove link', async () => {
    t = setup({ leads: [{ id: ID1, name: 'Dana', company: 'Acme', email: 'dana@acme.com', status: 'NEW', notes: null, submission_count: 1 }] })
    const res = await t.mod.adminAddSuppression(t.c({ body: { email: 'DANA@Acme.com' } }))
    expect(res.body).toMatchObject({ success: true, data: { leadsRemoved: 1 } })
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
    expect(t.state.leads).toHaveLength(0)
  })
  it('is idempotent — adding an already-suppressed address does not error', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    const res = await t.mod.adminAddSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
  })
  it('audits by hash, never by address', async () => {
    t = setup()
    await t.mod.adminAddSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    expect(t.state.audit).toHaveLength(1)
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.suppression_add', target_id: sha('dana@acme.com') })
    expect(JSON.stringify(t.state.audit[0])).not.toContain('dana@acme.com')
  })
  it('rejects a malformed email before touching the DB', async () => {
    t = setup()
    await expect(t.mod.adminAddSuppression(t.c({ body: { email: 'not-an-email' } }))).rejects.toBeTruthy()
  })
  it('once suppressed, the public form silently drops a resubmission', async () => {
    t = setup()
    await t.mod.adminAddSuppression(t.c({ body: { email: 'dana@acme.com' } }))
    const res = await submit(valid({ email: 'dana@acme.com' }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
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
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', role_category: 'legal' })], kv: { 'rl:leadack:budget': JSON.stringify({ count: 30, windowStart: Date.now(), refunds: 0 }) } })
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
    t = setup({ leads: [mkLead()], ackResult: 'throttled' })
    const res = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(429)
    expect(res.body).toMatchObject({ success: false, code: 'EMAIL_LIMIT' })
  })
  it('says so when the address bounced or reported spam (409), and when the provider failed (502)', async () => {
    t = setup({ leads: [mkLead()], ackResult: 'suppressed' })
    const blocked = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(blocked.status).toBe(409)
    expect(blocked.body).toMatchObject({ success: false, code: 'MAIL_SUPPRESSED' })
    t.restore()
    t = setup({ leads: [mkLead()], ackResult: false })
    const failed = await t.mod.adminRequestConfirmation(t.c({ params: { id: ID1 } }))
    expect(failed.status).toBe(502)
    expect(failed.body).toMatchObject({ success: false, code: 'SEND_FAILED' })
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

// ══ Fresh audit pass 2 (Section 5) ══════════════════════════════════════════

describe('B1 — a failing KV never costs a lead its notices', () => {
  it('still sends the owner notice and the acknowledgement when the budget store throws', async () => {
    const dead = new Proxy({}, { get() { throw new Error('KV GET failed: 429') } })
    t = setup({ kv: dead })
    await submit(valid())
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.acks).toHaveLength(1)
  })
})

describe('B2 — an unconfirmed lead resubmitting does not spend both acknowledgement slots at once', () => {
  const unconfirmed = (minutesAgo) => mkLead({ email: 'dana@acme.com', name: 'Dana', company: 'Acme',
    last_ack_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), created_at: '2026-01-01T00:00:00.000Z' })
  it('does not re-send within the cooldown (a double-click)', async () => {
    t = setup({ leads: [unconfirmed(1)] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(0)
    expect(t.state.leads[0].submission_count).toBe(2)   // still recorded
  })
  it('re-sends once the cooldown has passed', async () => {
    t = setup({ leads: [unconfirmed(30)] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(1)
  })
})

describe('B3 — names made only of invisible letters are rejected', () => {
  it.each([
    ['Hangul filler', '\u3164\u3164'], ['halfwidth Hangul filler', '\uffa0'], ['choseong filler', '\u115f'],
    ['jungseong filler', '\u1160'], ['Arabic letter mark', '\u061c'], ['combining grapheme joiner', '\u034f'],
    ['Khmer inherent vowel', '\u17b4\u17b5'],
  ])('%s', async (_label, name) => {
    t = setup()
    await expect(submit(valid({ name }))).rejects.toBeTruthy()
    expect(t.state.leads).toHaveLength(0)
  })
  it('strips the same characters out of an otherwise real name', async () => {
    t = setup()
    await submit(valid({ name: 'Da\u3164na\u061c' }))
    expect(t.state.leads[0].name).toBe('Dana')
  })
})

describe('G1 — adminMarkConfirmed', () => {
  it('confirms an unconfirmed lead and audits it', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const res = await t.mod.adminMarkConfirmed(t.c({ params: { id: ID1 } }))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true })
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.mark_confirmed', target_id: ID1 })
  })
  it('409s an already-confirmed lead without touching its timestamp, 404s an unknown one, 400s a bad id', async () => {
    t = setup({ leads: [mkLead({ confirmed_at: '2026-02-01T00:00:00.000Z' })] })
    expect((await t.mod.adminMarkConfirmed(t.c({ params: { id: ID1 } }))).status).toBe(409)
    expect(t.state.leads[0].confirmed_at).toBe('2026-02-01T00:00:00.000Z')
    expect((await t.mod.adminMarkConfirmed(t.c({ params: { id: ID2 } }))).status).toBe(404)
    expect((await t.mod.adminMarkConfirmed(t.c({ params: { id: 'nope' } }))).status).toBe(400)
    expect(t.state.audit).toHaveLength(0)
  })
})

describe('G2/G7 — list filters', () => {
  it('status=OPEN returns NEW and CONTACTED only, and counts.OPEN adds them', async () => {
    t = setup({ leads: [
      mkLead({ id: ID1, email: 'a@x.com', status: 'NEW' }), mkLead({ id: ID2, email: 'b@x.com', status: 'CONTACTED' }),
      mkLead({ id: 'gen-9', email: 'c@x.com', status: 'CONVERTED' }), mkLead({ id: 'gen-8', email: 'd@x.com', status: 'ARCHIVED' }),
    ] })
    const res = await t.mod.adminListLeads(t.c({ query: { status: 'OPEN' } }))
    expect(res.body.data.map(l => l.email).sort()).toEqual(['a@x.com', 'b@x.com'])
    expect(res.body.meta.counts.OPEN).toBe(2)
  })
  it('search also matches the verification page code and the admin notes', async () => {
    t = setup({ leads: [mkLead()] })
    await t.mod.adminListLeads(t.c({ query: { search: 'K7QX' } }))
    const expr = t.db.calls.find(c => c.or)?.or[0] || ''
    expect(expr).toContain('source_code.ilike.%K7QX%')
    expect(expr).toContain('notes.ilike.%K7QX%')
  })
  it('passes the badge threshold to the supply query', async () => {
    t = setup({ leads: [mkLead()] })
    await t.mod.adminListLeads(t.c())
    expect(t.db.calls.find(c => c.op === 'rpc').args).toEqual({ p_min_score: 80 })
  })
})

describe('G7 — adminCheckSuppression says whether a lead exists', () => {
  it('leadExists is true only when a lead is stored for the address', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    expect((await t.mod.adminCheckSuppression(t.c({ body: { email: 'dana@acme.com' } }))).body.data.leadExists).toBe(true)
    expect((await t.mod.adminCheckSuppression(t.c({ body: { email: 'other@acme.com' } }))).body.data.leadExists).toBe(false)
  })
})

describe('G4 — one-click unsubscribe', () => {
  it('removes the address and records the do-not-contact hash from a POST with the token in the URL', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const token = await tokenFor('remove', 'dana@acme.com')
    const res = await t.mod.unsubscribeLead({ ...t.c(), req: { query: k => k === 'token' ? token : undefined } })
    expect(res.status).toBe(200)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
  })
  it('refuses a confirm token, a missing token and garbage — and removes nothing', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const ctx = tok => ({ ...t.c(), req: { query: k => k === 'token' ? tok : undefined } })
    expect((await t.mod.unsubscribeLead(ctx(await tokenFor('confirm', 'dana@acme.com')))).status).toBe(400)
    expect((await t.mod.unsubscribeLead(ctx(undefined))).status).toBe(400)
    expect((await t.mod.unsubscribeLead(ctx('x.y'))).status).toBe(400)
    expect(t.state.leads).toHaveLength(1)
  })
  it('hands the acknowledgement a one-click URL built from the request origin', async () => {
    t = setup()
    const ctx = t.c({ body: valid() })
    ctx.req.url = 'https://api.passthrough.dev/api/employer-leads'
    await t.mod.createLead(ctx); await Promise.all(ctx._waits)
    expect(t.state.ackLinks[0].unsubscribeUrl).toMatch(/^https:\/\/api\.passthrough\.dev\/api\/employer-leads\/unsubscribe\?token=/)
  })
  it('API_ORIGIN overrides the request origin; with neither, the email just goes without the header', async () => {
    t = setup()
    const a = t.c({ body: valid() }); a.env = { ...a.env, API_ORIGIN: 'https://edge.example.com/' }
    await t.mod.createLead(a); await Promise.all(a._waits)
    expect(t.state.ackLinks[0].unsubscribeUrl).toMatch(/^https:\/\/edge\.example\.com\/api\/employer-leads\/unsubscribe/)
    t.restore(); t = setup()
    await submit(valid())
    expect(t.state.ackLinks[0].unsubscribeUrl).toBeNull()
  })
})

describe('G5 — Turnstile on the public form', () => {
  let realFetch
  beforeEach(() => { realFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = realFetch })
  const withSecret = (ctx) => { ctx.env = { ...ctx.env, TURNSTILE_SECRET_KEY: 'sek' }; return ctx }

  it('is inert without TURNSTILE_SECRET_KEY', async () => {
    t = setup()
    await submit(valid())
    expect(t.state.leads).toHaveLength(1)
  })
  it('rejects with a real error when the secret is set and no token came', async () => {
    t = setup()
    const res = await t.mod.createLead(withSecret(t.c({ body: valid() })))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ success: false, code: 'CAPTCHA_FAILED' })
    expect(t.state.leads).toHaveLength(0)
  })
  it('rejects when Cloudflare says the token is bad, accepts when it says good', async () => {
    t = setup()
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: false }) })
    expect((await t.mod.createLead(withSecret(t.c({ body: valid({ turnstileToken: 'bad' }) })))).status).toBe(400)
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) })
    const ctx = withSecret(t.c({ body: valid({ turnstileToken: 'good' }) }))
    expect((await t.mod.createLead(ctx)).status).toBe(200)
    await Promise.all(ctx._waits)
    expect(t.state.leads).toHaveLength(1)
  })
  it('lets the submission through when Cloudflare itself is unreachable', async () => {
    t = setup()
    globalThis.fetch = async () => { throw new Error('network down') }
    const ctx = withSecret(t.c({ body: valid({ turnstileToken: 'x' }) }))
    expect((await t.mod.createLead(ctx)).status).toBe(200)
    await Promise.all(ctx._waits)
    expect(t.state.leads).toHaveLength(1)
  })
})

// ══ Independent audit round 6 (Section 5) ═══════════════════════════════════════════════════════
// A Durable-Object-style limiter: one object per key, every operation serialised — the same
// guarantee RateLimiterDO gives in production (lib/rateLimiterDO.js runs these very OPS).
function fakeDO() {
  const core = require('../src/lib/rateLimitCore.js')
  const stores = new Map()
  const storeFor = (name) => {
    if (!stores.has(name)) { const m = new Map(); stores.set(name, { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v) }, delete: async k => { m.delete(k) } }) }
    return stores.get(name)
  }
  const chain = new Map()
  return {
    idFromName: n => n,
    get: name => ({ fetch: (url, init) => {
      const { op, args } = JSON.parse(init.body)
      const run = (chain.get(name) || Promise.resolve()).then(() => core.OPS[op](storeFor(name), args))
      chain.set(name, run.catch(() => {}))
      return run.then(result => ({ ok: true, json: async () => result }))
    } }),
  }
}

describe('R6-B1 — the hourly notice / acknowledgement budgets hold under a concurrent burst', () => {
  // Workers KV as production behaves: reads/writes are asynchronous, and a SECOND write to one key
  // within a second is rejected with a 429. (The old hand-rolled counter treated that rejection as an
  // outage and let the send through, so under a burst almost no increment was ever recorded.)
  const strictKv = () => {
    const m = new Map(), wrote = new Map()
    return {
      get: async k => { await new Promise(r => setTimeout(r, 1)); return m.get(k) ?? null },
      put: async (k, v) => { await new Promise(r => setTimeout(r, 1)); if (Date.now() - (wrote.get(k) || 0) < 1000) throw new Error('KV PUT failed: 429'); wrote.set(k, Date.now()); m.set(k, v) },
    }
  }
  it('40 simultaneous brand-new leads send at most 20 owner notices and 30 acknowledgements', async () => {
    t = setup({ envExtra: { RATE_LIMIT_DO: fakeDO(), RATE_LIMIT_KV: strictKv() } })
    await Promise.all(Array.from({ length: 40 }, (_, i) => submit(valid({ email: `lead${i}@corp${i}.com` }))))
    expect(t.state.leads).toHaveLength(40)          // every lead is still stored — only the EMAILS are budgeted
    expect(t.state.notices).toHaveLength(20)
    expect(t.state.acks).toHaveLength(30)
  })
  it('goes through the shared limiter (a Durable Object when bound), never a hand-rolled KV counter', async () => {
    t = setup({ envExtra: { RATE_LIMIT_DO: fakeDO() } })
    await submit(valid())
    expect(Object.keys(t.state.kv).filter(k => k.startsWith('rl:lead'))).toEqual([])
  })
  it('a failing limiter backend never costs a lead its notices (fails open)', async () => {
    t = setup({ envExtra: { RATE_LIMIT_DO: { idFromName: n => n, get: () => ({ fetch: async () => { throw new Error('DO down') } }) } } })
    await submit(valid())
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.acks).toHaveLength(1)
  })
})

describe('R6-B2 — resubmission cooldowns run from when the email actually went out', () => {
  const unconfirmed = (over = {}) => mkLead({ email: 'dana@acme.com', name: 'Dana', company: 'Acme', created_at: '2026-01-01T00:00:00.000Z', ...over })
  const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()
  it('re-sends the confirmation to someone retrying every few minutes, because the CLOCK is the last email, not the last submission', async () => {
    t = setup({ leads: [unconfirmed({ last_submitted_at: minutesAgo(2), last_ack_at: minutesAgo(11) })] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(1)
  })
  it('records last_ack_at when a confirmation really goes out, so the next retry measures from it', async () => {
    t = setup()
    await submit(valid())
    expect(t.state.leads[0].last_ack_at).toBeTruthy()
    await submit(valid())                       // an immediate double-click
    expect(t.state.acks).toHaveLength(1)
  })
  it('does not record last_ack_at for an acknowledgement that did not go out', async () => {
    t = setup({ ackResult: false })
    await submit(valid())
    expect(t.state.leads[0].last_ack_at).toBeUndefined()
  })
  it('a lead that predates the columns falls back to created_at (first email attempted at creation)', async () => {
    t = setup({ leads: [unconfirmed({ created_at: minutesAgo(3), last_submitted_at: minutesAgo(3) })] })
    await submit(valid())
    expect(t.state.acks).toHaveLength(0)
  })
  it('the owner "resubmitted" notice is measured from the last notice, and stamped only when it really went out', async () => {
    const day = 24 * 60 * 60_000
    t = setup({ leads: [unconfirmed({ confirmed_at: '2026-01-02T00:00:00.000Z', last_submitted_at: minutesAgo(5), last_notice_at: new Date(Date.now() - 2 * day).toISOString() })] })
    await submit(valid())
    expect(t.state.notices).toHaveLength(1)     // old behaviour: silenced forever by the 5-minute-old submission
    expect(Date.now() - Date.parse(t.state.leads[0].last_notice_at)).toBeLessThan(60_000)
    await submit(valid())
    expect(t.state.notices).toHaveLength(1)     // and not again within 24h
  })
  it('a notice the budget skipped is not stamped, so the next resubmission can still deliver it', async () => {
    t = setup({ leads: [unconfirmed({ confirmed_at: '2026-01-02T00:00:00.000Z' })],
      kv: { 'rl:leadnotice:budget': JSON.stringify({ count: 20, windowStart: Date.now(), refunds: 0 }) } })
    await submit(valid())
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.leads[0].last_notice_at).toBeUndefined()
  })
})

describe('R6-B3 — adminCreateLead with overrideRemoval is safe to retry', () => {
  const body = (over = {}) => ({ name: 'Ann', company: 'Co', email: 'ann@co.com', ...over })
  it('a failed lift after the insert leaves a retry able to finish the job (it used to 409 forever)', async () => {
    t = setup({ suppressed: [sha('ann@co.com')], liftError: { message: 'db hiccup' } })
    await expect(t.mod.adminCreateLead(t.c({ body: body({ overrideRemoval: true }) }))).rejects.toBeTruthy()
    expect(t.state.leads).toHaveLength(1)           // the lead did get created
    t.restore()
    // retry against the same table, now with the database healthy
    const leads = t.state.leads, suppressed = t.state.suppressed
    t = setup({ leads, suppressed: [...suppressed] })
    const res = await t.mod.adminCreateLead(t.c({ body: body({ overrideRemoval: true }) }))
    expect(res.status).toBe(409)
    expect(res.body.suppressionLifted).toBe(true)
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.audit[0]).toMatchObject({ action: 'lead.suppression_lift' })
  })
  it('without the override, an existing lead + suppression is left exactly as it was', async () => {
    t = setup({ leads: [mkLead({ email: 'ann@co.com' })], suppressed: [sha('ann@co.com')] })
    const res = await t.mod.adminCreateLead(t.c({ body: body() }))
    expect(res.status).toBe(409)
    expect(t.state.suppressed.size).toBe(1)
  })
})

describe('R6-G3 — a capped CSV export says so', () => {
  it('reports X-Export-Truncated: false and the row count for a complete export', async () => {
    t = setup({ leads: [mkLead()] })
    const res = await t.mod.adminExportLeads(t.c({}))
    expect(res.headers['X-Export-Truncated']).toBe('false')
    expect(res.headers['X-Export-Rows']).toBe('1')
  })
  it('flags truncation exactly when more rows exist than the cap — and not when there are exactly cap rows', async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(6, '0')}`, name: 'N', company: 'C', email: `e${i}@x.com`,
      status: 'NEW', notes: null, submission_count: 1, created_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() }))
    const run = async (total) => {
      const all = mk(total)
      const db = createFakeSupabase(q => {
        if (q.table === 'admin_audit_log') return { data: null, error: null }
        if (q.table !== 'employer_leads') return undefined
        if (q.selectOpts?.head) return { count: all.length, error: null }
        // keyset cursor is irrelevant to this fake: hand out the next slice by how many were already given
        db.given = db.given || 0
        const slice = all.slice(db.given, db.given + q.limit)
        db.given += slice.length
        return { data: slice, error: null }
      })
      const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': {} })
      try { return await mod.adminExportLeads({ env: {}, get: () => ({ id: 'a', role: 'ADMIN' }), req: { query: () => undefined, header: () => undefined },
        json: b => b, body: drainBody }) } finally { restore() }
    }
    const exact = await run(50_000)
    expect(exact.headers['X-Export-Truncated']).toBe('false')
    expect(exact.headers['X-Export-Rows']).toBe('50000')
    const over = await run(50_001)
    expect(over.headers['X-Export-Truncated']).toBe('true')
    expect(over.headers['X-Export-Rows']).toBe('50000')
    expect(over.raw.split('\r\n').filter(Boolean)).toHaveLength(50_001)   // header + exactly 50,000 rows
  })
})

describe('R6-G1 — adminNotifyCandidates', () => {
  const NOW_ISO = () => new Date().toISOString()
  const confirmedLead = (over = {}) => mkLead({ role_category: 'sales', confirmed_at: '2026-02-01T00:00:00.000Z', ...over })
  const post = (body) => t.mod.adminNotifyCandidates(t.c({ body }))
  const supply = [{ role_category: 'sales', candidate_count: '3' }]

  it('emails confirmed open leads in the field, names no candidate, carries a removal link, and moves NEW to CONTACTED', async () => {
    t = setup({ supply, leads: [confirmedLead({ id: ID1, email: 'a@acme.com' }), confirmedLead({ id: ID2, email: 'b@acme.com', status: 'CONTACTED', contacted_at: '2026-03-01T00:00:00.000Z' })] })
    const res = await post({ field: 'sales' })
    expect(res.body.data).toMatchObject({ field: 'sales', candidates: 3, eligible: 2, sent: 2, failed: 0, remaining: 0 })
    expect(t.state.candidateMails.map(m => m.to).sort()).toEqual(['a@acme.com', 'b@acme.com'])
    expect(t.state.candidateMails[0]).toMatchObject({ field: 'Sales', count: 3 })
    expect(t.state.candidateMails[0].links.removeUrl).toContain('/remove')
    const [a, b] = [t.state.leads.find(l => l.id === ID1), t.state.leads.find(l => l.id === ID2)]
    expect(a).toMatchObject({ status: 'CONTACTED' }); expect(a.contacted_at).toBeTruthy(); expect(a.last_candidates_notified_at).toBeTruthy()
    expect(b.contacted_at).toBe('2026-03-01T00:00:00.000Z')            // an existing contacted_at is never rewound
    expect(t.state.audit.at(-1)).toMatchObject({ action: 'lead.notify_candidates', detail: { field: 'sales', sent: 2, failed: 0 } })
    expect(JSON.stringify(t.state.audit.at(-1))).not.toContain('@acme.com')   // ids and counts only, never an address
  })
  it('skips unconfirmed leads, other fields, closed leads, uncategorised leads, and anyone told in the last 30 days', async () => {
    t = setup({ supply, leads: [
      confirmedLead({ id: ID1, email: 'ok@acme.com' }),
      confirmedLead({ id: 'x2', email: 'unconfirmed@acme.com', confirmed_at: null }),
      confirmedLead({ id: 'x3', email: 'legal@acme.com', role_category: 'legal' }),
      confirmedLead({ id: 'x4', email: 'archived@acme.com', status: 'ARCHIVED' }),
      confirmedLead({ id: 'x5', email: 'converted@acme.com', status: 'CONVERTED' }),
      confirmedLead({ id: 'x6', email: 'none@acme.com', role_category: null }),
      confirmedLead({ id: 'x7', email: 'recent@acme.com', candidates_notified_fields: { sales: new Date(Date.now() - 5 * 86400_000).toISOString() } }),
      confirmedLead({ id: 'x8', email: 'old@acme.com', candidates_notified_fields: { sales: new Date(Date.now() - 40 * 86400_000).toISOString() } }),
    ] })
    const res = await post({ field: 'sales' })
    expect(t.state.candidateMails.map(m => m.to).sort()).toEqual(['ok@acme.com', 'old@acme.com'])
    expect(res.body.data).toMatchObject({ eligible: 2, sent: 2 })
  })
  it('pressing it twice mails nobody twice', async () => {
    t = setup({ supply, leads: [confirmedLead({ id: ID1, email: 'a@acme.com' })] })
    await post({ field: 'sales' })
    const second = await post({ field: 'sales' })
    expect(t.state.candidateMails).toHaveLength(1)
    expect(second.body.data).toMatchObject({ eligible: 0, sent: 0 })
  })
  it('refuses when the field has no Verified candidates — there is nothing to tell anyone', async () => {
    t = setup({ supply: [], leads: [confirmedLead()] })
    const res = await post({ field: 'sales' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('NO_CANDIDATES')
    expect(t.state.candidateMails).toHaveLength(0)
  })
  it('dryRun reports who would be emailed and sends nothing', async () => {
    t = setup({ supply, leads: [confirmedLead()] })
    const res = await post({ field: 'sales', dryRun: true })
    expect(res.body.data).toMatchObject({ eligible: 1, sent: 0, dryRun: true, candidates: 3 })
    expect(t.state.candidateMails).toHaveLength(0)
    expect(t.state.audit.some(a => a.action === 'lead.notify_candidates')).toBe(false)
  })
  it('sends at most 25 per call and says how many remain', async () => {
    t = setup({ supply, leads: Array.from({ length: 30 }, (_, i) => confirmedLead({ id: `id-${i}`, email: `l${i}@acme.com` })) })
    const res = await post({ field: 'sales' })
    expect(res.body.data).toMatchObject({ eligible: 30, sent: 25, remaining: 5 })
    const next = await post({ field: 'sales' })
    expect(next.body.data).toMatchObject({ eligible: 5, sent: 5, remaining: 0 })
  })
  it('a lead whose email did not go out is neither stamped nor moved to CONTACTED, and is counted as failed', async () => {
    t = setup({ supply, candidateMailResult: (to) => to !== 'bad@acme.com',
      leads: [confirmedLead({ id: ID1, email: 'bad@acme.com' }), confirmedLead({ id: ID2, email: 'good@acme.com' })] })
    const res = await post({ field: 'sales' })
    // round 8: a lead that failed is reported as failed, not also as "still waiting"
    expect(res.body.data).toMatchObject({ sent: 1, failed: 1, remaining: 0 })
    const bad = t.state.leads.find(l => l.id === ID1)
    expect(bad.status).toBe('NEW'); expect(bad.last_candidates_notified_at).toBeUndefined()
  })
  it('never emails an address that is on the do-not-contact list, even if its lead row still exists', async () => {
    t = setup({ supply, suppressed: [sha('gone@acme.com')],
      leads: [confirmedLead({ id: ID1, email: 'gone@acme.com' }), confirmedLead({ id: ID2, email: 'here@acme.com' })] })
    const res = await post({ field: 'sales' })
    expect(t.state.candidateMails.map(m => m.to)).toEqual(['here@acme.com'])
    expect(res.body.data).toMatchObject({ sent: 1, failed: 0, skipped: 1, remaining: 0 })
  })
  it('rejects a field outside the taxonomy', async () => {
    t = setup({ supply })
    await expect(post({ field: 'plumbing' })).rejects.toBeTruthy()
    await expect(post({})).rejects.toBeTruthy()
  })
  it('is admin-only at the route', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/employer-leads.routes.js'), 'utf8')
    expect(src).toMatch(/router\.post\('\/notify-candidates', admin, c\.adminNotifyCandidates\)/)
  })
})


describe('R7 — independent audit round 7', () => {
  const ctxWith = (query, env = { FRONTEND_URL: 'https://passthrough.dev/' }) => ({
    env, req: { query: k => query[k] }, redirect: (url, status) => ({ redirected: true, url, status }) })

  it('GET /unsubscribe hands a plain link-follower to the remove page (and removes nobody)', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const token = await tokenFor('remove', 'dana@acme.com')
    const res = t.mod.unsubscribeRedirect(ctxWith({ token }))
    expect(res).toEqual({ redirected: true, status: 302, url: `https://passthrough.dev/employer/remove?token=${encodeURIComponent(token)}` })
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.suppressed.size).toBe(0)
  })
  it('GET /unsubscribe with a missing or absurd token still lands on the remove page, without echoing it', () => {
    t = setup()
    expect(t.mod.unsubscribeRedirect(ctxWith({})).url).toBe('https://passthrough.dev/employer/remove')
    expect(t.mod.unsubscribeRedirect(ctxWith({ token: 'x'.repeat(701) })).url).toBe('https://passthrough.dev/employer/remove')
    expect(t.mod.unsubscribeRedirect(ctxWith({ token: 'a&b=c#d.e-f-ghij' })).url).toContain('token=a%26b%3Dc%23d.e-f-ghij')
  })

  describe('lead-link secrets', () => {
    const NEW_SECRET = 'a-brand-new-lead-link-secret-000000000000'
    const post = async (mod, env, token) => mod.confirmLead({ ...t.c(), env: { ...t.c().env, ...env }, req: { json: async () => ({ token }) } })
    it('signs with LEAD_LINK_SECRET when set, else JWT_SECRET', async () => {
      t = setup({ leads: [mkLead({ email: 'dana@acme.com', confirmed_at: null })] })
      const ctx = t.c({ body: valid({ email: 'new@acme.com' }) })
      ctx.env = { ...ctx.env, LEAD_LINK_SECRET: NEW_SECRET }
      await t.mod.createLead(ctx); await Promise.all(ctx._waits)
      const { verifyLeadToken } = await import('../src/lib/leadTokens.js')
      expect(await verifyLeadToken(NEW_SECRET, 'confirm', new URL(t.state.ackLinks[0].confirmUrl).searchParams.get('token'))).toBe('new@acme.com')
      expect(await verifyLeadToken(SECRET, 'confirm', new URL(t.state.ackLinks[0].confirmUrl).searchParams.get('token'))).toBeNull()
    })
    it('links signed before LEAD_LINK_SECRET existed (with JWT_SECRET) keep working once it is set', async () => {
      t = setup({ leads: [mkLead({ email: 'dana@acme.com', confirmed_at: null })] })
      const res = await post(t.mod, { LEAD_LINK_SECRET: NEW_SECRET }, await tokenFor('confirm', 'dana@acme.com'))
      expect(res.body.status).toBe('confirmed')
    })
    it('rotating: the previous key still verifies, an unrelated key does not — and a removal link survives a JWT_SECRET change', async () => {
      t = setup({ leads: [mkLead({ email: 'dana@acme.com', confirmed_at: null })] })
      const old = await tokenFor('remove', 'dana@acme.com')                    // signed with the OLD JWT_SECRET
      const rotated = { JWT_SECRET: 'the-rotated-session-secret-0000000000000', LEAD_LINK_SECRET: NEW_SECRET, LEAD_LINK_SECRET_PREVIOUS: SECRET }
      const ok = await t.mod.removeLead({ ...t.c(), env: { ...t.c().env, ...rotated }, req: { json: async () => ({ token: old }) } })
      expect(ok.status).toBe(200)
      expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
      t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
      const bad = await t.mod.removeLead({ ...t.c(), env: { ...t.c().env, JWT_SECRET: 'the-rotated-session-secret-0000000000000' }, req: { json: async () => ({ token: old }) } })
      expect(bad.status).toBe(400)                                              // no PREVIOUS configured: old links are dead, as before
      expect(t.state.leads).toHaveLength(1)
    })
  })

  describe('invisible characters', () => {
    const tag = String.fromCodePoint(0xE0049, 0xE0067)
    it('strips Unicode tag characters and the other invisible format controls from name, company and role title', async () => {
      t = setup()
      await submit(valid({ name: `Dana${tag}\u206a\u2065\u180b\ufff9`, company: `Acme${tag}`, roleTitle: `Eng${tag}` }))
      expect(t.state.leads[0]).toMatchObject({ name: 'Dana', company: 'Acme', role_title: 'Eng' })
      expect(t.state.notices[0].message).not.toMatch(/[\u{e0000}-\u{e007f}]/u)
    })
    it('a name made only of tag characters is not a name', async () => {
      t = setup()
      const ctx = t.c({ body: valid({ name: tag }) })
      await expect(t.mod.createLead(ctx)).rejects.toThrow()
      expect(t.state.leads).toHaveLength(0)
    })
    it('still keeps joiners and emoji variation selectors', async () => {
      t = setup()
      await submit(valid({ name: 'می\u200cخواهم \u2764\ufe0f' }))
      expect(t.state.leads[0].name).toBe('می\u200cخواهم \u2764\ufe0f')
    })
    it('admin notes lose them too, but keep their line breaks', async () => {
      t = setup()
      const res = await t.mod.adminCreateLead(t.c({ body: { name: 'A', company: 'B', email: 'x@y.com', notes: `line one${tag}\nline two` } }))
      expect(res.body.data.notes).toBe('line one\nline two')
    })
  })

  describe('honeypot', () => {
    it('the new `trap` field trips it exactly like `website` did: success answer, nothing stored', async () => {
      t = setup()
      const res = await submit(valid({ trap: 'http://spam.example' }))
      expect(res.body.success).toBe(true)
      expect(t.state.leads).toHaveLength(0)
      expect(t.state.notices).toHaveLength(0)
    })
    it('an empty trap (what a person submits) stores the lead', async () => {
      t = setup()
      await submit(valid({ trap: '' }))
      expect(t.state.leads).toHaveLength(1)
    })
  })

  describe('contacted_at', () => {
    it('is stamped when a lead goes straight to CONVERTED (single update, bulk, manual add)', async () => {
      t = setup({ leads: [mkLead({ id: ID1, email: 'a@b.com' }), mkLead({ id: ID2, email: 'c@d.com' })] })
      await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'CONVERTED' } }))
      expect(t.state.leads.find(l => l.id === ID1).contacted_at).toBeTruthy()
      await t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID2], action: 'setStatus', status: 'CONVERTED' } }))
      expect(t.state.leads.find(l => l.id === ID2).contacted_at).toBeTruthy()
      const created = await t.mod.adminCreateLead(t.c({ body: { name: 'A', company: 'B', email: 'm@n.com', status: 'CONVERTED' } }))
      expect(created.body.data.contactedAt).toBeTruthy()
    })
    it('NEW and ARCHIVED still do not stamp it', async () => {
      t = setup({ leads: [mkLead({ id: ID1, email: 'a@b.com' })] })
      await t.mod.adminUpdateLeadStatus(t.c({ params: { id: ID1 }, body: { status: 'ARCHIVED' } }))
      expect(t.state.leads[0].contacted_at).toBeNull()
    })
  })

  describe('bulk status — the first-contact stamp failing halfway', () => {
    it('still records the status change in the audit log, then reports the failure', async () => {
      t = setup({ failContactStamp: true, leads: [mkLead({ id: ID1, email: 'a@b.com' })] })
      await expect(t.mod.adminBulkUpdateLeads(t.c({ body: { ids: [ID1], action: 'setStatus', status: 'CONTACTED' } }))).rejects.toMatchObject({ message: 'stamp failed' })
      expect(t.state.leads[0].status).toBe('CONTACTED')                          // the first write did land
      expect(t.state.audit.at(-1)).toMatchObject({ action: 'lead.bulk_status', detail: { status: 'CONTACTED', ids: [ID1], contactedStampFailed: true } })
    })
  })

  describe('notify-candidates — unmailable leads cannot starve the rest', () => {
    it('25 leads that cannot be mailed at the front of the queue do not stop the ones behind them', async () => {
      const supply = [{ role_category: 'sales', candidate_count: '2' }]
      const mk = (i, over = {}) => mkLead({ id: `lead-${String(i).padStart(3, '0')}`, email: `l${i}@acme.com`, role_category: 'sales',
        confirmed_at: '2026-02-01T00:00:00.000Z', created_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00.000Z`, ...over })
      const leads = Array.from({ length: 30 }, (_, i) => mk(i))
      t = setup({ supply, leads, candidateMailResult: (to) => !/^l([0-9]|1[0-9]|2[0-4])@/.test(to) })   // the first 25 bounce
      const res = await t.mod.adminNotifyCandidates(t.c({ body: { field: 'sales' } }))
      expect(res.body.data).toMatchObject({ sent: 5, failed: 25 })
    })
    it('still mails at most 25 per call', async () => {
      const supply = [{ role_category: 'sales', candidate_count: '2' }]
      const leads = Array.from({ length: 40 }, (_, i) => mkLead({ id: `lead-${String(i).padStart(3, '0')}`, email: `l${i}@acme.com`, role_category: 'sales', confirmed_at: '2026-02-01T00:00:00.000Z' }))
      t = setup({ supply, leads })
      const res = await t.mod.adminNotifyCandidates(t.c({ body: { field: 'sales' } }))
      expect(res.body.data).toMatchObject({ sent: 25, failed: 0, remaining: 15 })
    })
  })
})


// ═════════════════════════════════════════════════════════════════════════
// Independent audit round 8 (Section 5)
// ═════════════════════════════════════════════════════════════════════════
describe('R8 — adminExportLeads', () => {
  const exportWith = async (resolverRows, perRequest) => {
    const all = resolverRows
    const db = createFakeSupabase(q => {
      if (q.table === 'admin_audit_log') return { data: null, error: null }
      if (q.table !== 'employer_leads') return undefined
      if (q.selectOpts?.head) return { count: all.length, error: null }
      db.given = db.given || 0
      const slice = all.slice(db.given, db.given + Math.min(q.limit, perRequest))
      db.given += slice.length
      return { data: slice, error: null }
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': {} })
    try { return await mod.adminExportLeads({ env: {}, get: () => ({ id: 'a', role: 'ADMIN' }), req: { query: () => undefined, header: () => undefined },
      json: b => b, body: drainBody }) } finally { restore() }
  }
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `id-${String(i).padStart(4, '0')}`, name: 'N', company: 'C', email: `e${i}@x.com`,
    status: 'NEW', notes: null, submission_count: 1, created_at: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() }))

  it('keeps paging when the server answers short pages (a max-rows setting below the chunk size) — it used to stop after one', async () => {
    const res = await exportWith(rows(5), 2)
    expect(res.headers['X-Export-Rows']).toBe('5')
    expect(res.headers['X-Export-Truncated']).toBe('false')
    expect(res.raw.split('\r\n').filter(Boolean)).toHaveLength(6)   // header + 5
  })

  it('adds the outreach clocks and the lead id as trailing columns', async () => {
    t = setup({ leads: [mkLead({ last_ack_at: '2026-03-01T00:00:00.000Z', last_notice_at: '2026-03-02T00:00:00.000Z', last_candidates_notified_at: '2026-03-03T00:00:00.000Z' })] })
    const res = await t.mod.adminExportLeads(t.c({}))
    const [header, line] = res.raw.replace('\uFEFF', '').split('\r\n')
    expect(header.startsWith('"Name","Company","Email"')).toBe(true)   // existing positions unchanged
    expect(header).toContain('"Acknowledgement last sent","Resubmission notice last sent","Candidates last notified","Lead id"')
    expect(line).toContain(`"2026-03-01T00:00:00.000Z","2026-03-02T00:00:00.000Z","2026-03-03T00:00:00.000Z","${ID1}"`)
  })

  it('does not record the default sort as a filter in the audit entry, but does record a chosen one', async () => {
    t = setup({ leads: [mkLead()] })
    await t.mod.adminExportLeads(t.c({}))
    await t.mod.adminExportLeads(t.c({ query: { sort: 'activity', status: 'NEW' } }))
    const entries = t.state.audit.filter(a => a.action === 'lead.export')
    expect(entries[0].detail.filters).toEqual({})
    expect(entries[1].detail.filters).toEqual({ status: 'NEW', sort: 'activity' })
  })
})

describe('R8 — createLead answers after one insert and settles the rest afterwards', () => {
  it('hands a new lead and a duplicate to the background the same way (one waited task each)', async () => {
    t = setup({ leads: [mkLead({ email: 'old@acme.com', confirmed_at: '2026-01-02T00:00:00.000Z' })] })
    const fresh = t.c({ body: valid({ email: 'new@acme.com' }) })
    await t.mod.createLead(fresh)
    const dup = t.c({ body: valid({ email: 'old@acme.com' }) })
    await t.mod.createLead(dup)
    expect(fresh._waits).toHaveLength(1)
    expect(dup._waits).toHaveLength(1)
    await Promise.all([...fresh._waits, ...dup._waits])
    expect(t.state.leads.find(l => l.email === 'old@acme.com').submission_count).toBe(2)
  })

  it('a failing background merge never turns into an error for the submitter (the lead already exists)', async () => {
    const db = createFakeSupabase(q => {
      if (q.table !== 'employer_leads') return { data: null, error: null }
      if (q.op === 'insert') return { error: { code: '23505', message: 'duplicate key' } }
      return { error: { message: 'db down' } }   // the read the merge starts with
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
      'config/supabase.js': { getSupabase: () => db },
      'services/email.service.js': { sendOwnerNotice: async () => {}, sendEmployerLeadAck: async () => true },
    })
    t = setup(); t.restore(); t.restore = restore
    const ctx = t.c({ body: valid() })
    const res = await mod.createLead(ctx)
    await Promise.all(ctx._waits)
    expect(res.body.success).toBe(true)
  })
})

describe('R8 — an address removed while its lead is being created does not keep the lead', () => {
  it('re-reads the do-not-contact list after the insert: drops the row, sends nothing', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    let reads = 0
    const real = t.state.suppressed.has.bind(t.state.suppressed)
    t.state.suppressed.has = (h) => ++reads > 1 && real(h)   // not on the list when the form checks, on it by the time the row exists
    const res = await submit(valid({ email: 'dana@acme.com' }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.notices).toHaveLength(0)
    expect(t.state.acks).toHaveLength(0)
  })
  it('a lead for an address that is NOT on the list is kept and announced as before', async () => {
    t = setup()
    await submit(valid())
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.notices).toHaveLength(1)
    expect(t.state.acks).toHaveLength(1)
  })
})

describe('R8 — FRONTEND_URL with a trailing slash', () => {
  it('does not put "//" in the emailed confirm and remove links', async () => {
    t = setup({ envExtra: { FRONTEND_URL: 'https://passthrough.dev/' } })
    await submit(valid())
    const { confirmUrl, removeUrl } = t.state.ackLinks[0]
    expect(confirmUrl.startsWith('https://passthrough.dev/employer/confirm?token=')).toBe(true)
    expect(removeUrl.startsWith('https://passthrough.dev/employer/remove?token=')).toBe(true)
  })
})

describe('R8 — removal also clears the address from the mail log', () => {
  const employerTemplates = ['employer_lead_ack', 'employer_candidates_available', 'employer_lead_rejoin']
  it('removeLead: hash first, then the lead, then the mail history of the two employer templates', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    await postToken(t.mod.removeLead, await tokenFor('remove', 'dana@acme.com'))
    expect(t.state.logPurges).toEqual([{ to: ['dana@acme.com'], template: employerTemplates }])
    const ops = t.db.calls.map(q => `${q.table}:${q.op}`)
    expect(ops.indexOf('employer_lead_suppressions:upsert')).toBeLessThan(ops.indexOf('employer_leads:delete'))
    expect(ops.indexOf('employer_leads:delete')).toBeLessThan(ops.indexOf('email_logs:delete'))
  })
  it('a failed purge never holds up the opt-out: the person is removed and told so', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })], logPurgeError: { message: 'db down' } })
    const res = await postToken(t.mod.removeLead, await tokenFor('remove', 'dana@acme.com'))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
  })
  it('...and neither does it hold up an admin\'s add-to-do-not-contact or delete-and-block', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })], logPurgeError: { message: 'db down' } })
    expect((await t.mod.adminDeleteLead(t.c({ params: { id: ID1 }, query: { suppress: 'true' } }))).body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(true)
  })
  it('the one-click unsubscribe does the same', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    const token = await tokenFor('remove', 'dana@acme.com')
    await t.mod.unsubscribeLead({ ...t.c(), req: { query: () => token } })
    expect(t.state.logPurges).toHaveLength(1)
    expect(t.state.leads).toHaveLength(0)
  })
  it('adminAddSuppression clears it too', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    await t.mod.adminAddSuppression(t.c({ body: { email: 'Dana@Acme.com' } }))
    expect(t.state.logPurges).toEqual([{ to: ['dana@acme.com'], template: employerTemplates }])
  })
})

describe('R8 — delete and block (single)', () => {
  it('?suppress=true records the address, clears its mail history, deletes the lead and says so in the audit entry', async () => {
    t = setup({ leads: [mkLead({ email: 'spam@x.com' })] })
    const res = await t.mod.adminDeleteLead(t.c({ params: { id: ID1 }, query: { suppress: 'true' } }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.suppressed.has(sha('spam@x.com'))).toBe(true)
    expect(t.state.logPurges).toHaveLength(1)
    expect(t.state.audit.find(a => a.action === 'lead.delete').detail).toEqual({ suppressed: true })
    expect(JSON.stringify(t.state.audit)).not.toContain('spam@x.com')
  })
  it('a plain delete still leaves the address free to come back', async () => {
    t = setup({ leads: [mkLead({ email: 'spam@x.com' })] })
    await t.mod.adminDeleteLead(t.c({ params: { id: ID1 } }))
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.logPurges).toHaveLength(0)
  })
  it('404s an unknown lead without recording anything', async () => {
    t = setup()
    const res = await t.mod.adminDeleteLead(t.c({ params: { id: ID1 }, query: { suppress: 'true' } }))
    expect(res.status).toBe(404)
    expect(t.state.suppressed.size).toBe(0)
  })
})

describe('R8 — bulk actions', () => {
  const bulk = (body) => t.mod.adminBulkUpdateLeads(t.c({ body }))
  const three = () => [
    mkLead({ id: ID1, email: 'a@x.com' }),
    mkLead({ id: ID2, email: 'b@x.com', confirmed_at: '2026-01-05T00:00:00.000Z' }),
    mkLead({ id: '33333333-3333-4333-8333-333333333333', email: 'c@x.com', role_category: 'sales' })
  ]
  const ID3 = '33333333-3333-4333-8333-333333333333'

  it('deleteAndSuppress: blocks every deleted address (one write), clears their mail history, deletes, audits', async () => {
    t = setup({ leads: three() })
    const res = await bulk({ ids: [ID1, ID2], action: 'deleteAndSuppress' })
    expect(res.body).toEqual({ success: true, affected: 2 })
    expect(t.state.leads.map(l => l.id)).toEqual([ID3])
    expect(t.state.suppressed.has(sha('a@x.com')) && t.state.suppressed.has(sha('b@x.com'))).toBe(true)
    expect(t.state.suppressed.has(sha('c@x.com'))).toBe(false)
    expect(t.state.logPurges[0].to.sort()).toEqual(['a@x.com', 'b@x.com'])
    expect(t.db.calls.filter(q => q.table === 'employer_lead_suppressions' && q.op === 'upsert')).toHaveLength(1)
    expect(t.state.audit.find(a => a.action === 'lead.bulk_delete').detail).toMatchObject({ suppressed: true })
  })
  it('plain bulk delete blocks nobody', async () => {
    t = setup({ leads: three() })
    await bulk({ ids: [ID1], action: 'delete' })
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.audit.find(a => a.action === 'lead.bulk_delete').detail).toEqual({ ids: [ID1] })
  })
  it('setField categorises the chosen leads, and null clears it', async () => {
    t = setup({ leads: three() })
    await bulk({ ids: [ID1, ID2], action: 'setField', field: 'finance' })
    expect(t.state.leads.map(l => l.role_category)).toEqual(['finance', 'finance', 'sales'])
    const res = await bulk({ ids: [ID1], action: 'setField', field: null })
    expect(res.body.affected).toBe(1)
    expect(t.state.leads[0].role_category).toBeNull()
    expect(t.state.audit.some(a => a.action === 'lead.bulk_field')).toBe(true)
  })
  it('setField needs a field, and only a real one', async () => {
    t = setup({ leads: three() })
    await expect(bulk({ ids: [ID1], action: 'setField' })).rejects.toBeTruthy()
    await expect(bulk({ ids: [ID1], action: 'setField', field: 'astronaut' })).rejects.toBeTruthy()
  })
  it('markConfirmed stamps only the unconfirmed ones and leaves a real confirmation time alone', async () => {
    t = setup({ leads: three() })
    const res = await bulk({ ids: [ID1, ID2], action: 'markConfirmed' })
    expect(res.body.affected).toBe(1)
    expect(t.state.leads.find(l => l.id === ID1).confirmed_at).toBeTruthy()
    expect(t.state.leads.find(l => l.id === ID2).confirmed_at).toBe('2026-01-05T00:00:00.000Z')
    expect(t.state.audit.find(a => a.action === 'lead.bulk_mark_confirmed').detail.ids).toEqual([ID1])
  })
  it('requestConfirmation mails only the unconfirmed ones, reports failures and skips, and does not spend the public hourly budget', async () => {
    t = setup({ leads: three() })
    const res = await bulk({ ids: [ID1, ID2, ID3], action: 'requestConfirmation' })
    expect(res.body).toEqual({ success: true, affected: 2, sent: 2, failed: 0, skipped: 1, blocked: 0 })
    expect(t.state.acks.map(a => a.to).sort()).toEqual(['a@x.com', 'c@x.com'])
    expect(t.state.audit.find(a => a.action === 'lead.bulk_request_confirmation').detail).toMatchObject({ failed: 0, skipped: 1 })
  })
  it('requestConfirmation counts an email that did not go out as failed', async () => {
    t = setup({ leads: three(), ackResult: false })
    const res = await bulk({ ids: [ID1, ID3], action: 'requestConfirmation' })
    expect(res.body).toMatchObject({ affected: 0, sent: 0, failed: 2 })
  })
  it('requestConfirmation is limited to 25 leads per call', async () => {
    t = setup()
    const ids = Array.from({ length: 26 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    await expect(bulk({ ids, action: 'requestConfirmation' })).rejects.toBeTruthy()
  })
  it('counts a repeated id once', async () => {
    t = setup({ leads: three() })
    const res = await bulk({ ids: [ID1, ID1.toUpperCase()], action: 'requestConfirmation' })
    expect(res.body).toMatchObject({ sent: 1, skipped: 0 })
  })
})

describe('R8 — notify-candidates and a lost "already told" stamp', () => {
  const supply = [{ role_category: 'sales', candidate_count: 3 }]
  const confirmedLead = (over = {}) => mkLead({ role_category: 'sales', confirmed_at: '2026-02-01T00:00:00.000Z', ...over })
  const post = (body) => t.mod.adminNotifyCandidates(t.c({ body }))

  it('a send refused because the address was already told adopts the logged time and counts as skipped, not failed', async () => {
    const earlier = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
    t = setup({ supply, candidateMailResult: false, mailLogs: [{ sent_at: earlier }], leads: [confirmedLead()] })
    const res = await post({ field: 'sales' })
    expect(res.body.data).toMatchObject({ sent: 0, failed: 0, skipped: 1, remaining: 0 })
    expect(t.state.leads[0].candidates_notified_fields.sales).toBe(earlier)
    // ...so the next call no longer even looks at it
    const next = await post({ field: 'sales' })
    expect(next.body.data.eligible).toBe(0)
  })
  it('a send that failed with no earlier email on record is a real failure and stays eligible', async () => {
    t = setup({ supply, candidateMailResult: false, mailLogs: [], leads: [confirmedLead()] })
    const res = await post({ field: 'sales' })
    expect(res.body.data).toMatchObject({ sent: 0, failed: 1, skipped: 0, remaining: 0 })
    expect(t.state.leads[0].last_candidates_notified_at).toBeUndefined()
  })
  it('remaining counts only leads not yet tried', async () => {
    t = setup({ supply, candidateMailResult: (to) => to !== 'l0@acme.com',
      leads: Array.from({ length: 30 }, (_, i) => confirmedLead({ id: `id-${i}`, email: `l${i}@acme.com` })) })
    const res = await post({ field: 'sales' })
    // 25 sent + 1 failed were tried; 4 are still waiting
    expect(res.body.data).toMatchObject({ sent: 25, failed: 1, remaining: 4 })
  })
})
