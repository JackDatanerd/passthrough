import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Employer leads, round 11 (independent audit of Section 5). Same in-memory fakes as the main controller test.

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
    if (q.table === 'email_suppressions') {
      state.mailBlocks = state.mailBlocks || new Map()
      const h = q.filters.find(f => f[1] === 'email_hash')?.[2]
      if (q.op === 'delete') { const had = state.mailBlocks.has(h); state.mailBlocks.delete(h); return { data: had ? [{ email_hash: h }] : [], error: null } }
      return { data: state.mailBlocks.get(h) || null, error: null }
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
      sendEmployerLeadRejoin: async (env, sb, to, links) => { state.rejoins = state.rejoins || []; state.rejoins.push({ to, links }); return true },
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


const mkLead = (over = {}) => ({
  id: ID1, name: 'A', company: 'B', email: 'a@b.com', status: 'NEW', notes: null, contacted_at: null,
  role_category: null, role_title: null, source: 'homepage', submission_count: 1, extra_role_categories: [],
  created_at: '2026-01-01T00:00:00.000Z', last_submitted_at: '2026-01-01T00:00:00.000Z', ...over,
})
const tokenFor = async (purpose, email) => (await import('../src/lib/leadTokens.js')).signLeadToken(SECRET, purpose, email)
const call = (fn, body, extra = {}) => fn(t.c({ body, ...extra }))
const { canonicalMailbox, suppressionHashes } = await import('../src/lib/mailbox.js')

describe('lib/mailbox — what counts as the same inbox', () => {
  it("drops +tags, Gmail dots and the googlemail domain; leaves other providers' dots alone", () => {
    expect(canonicalMailbox('Bob+news@Example.com')).toBe('bob@example.com')
    expect(canonicalMailbox('b.o.b@googlemail.com')).toBe('bob@gmail.com')
    expect(canonicalMailbox('b.o.b@acme.com')).toBe('b.o.b@acme.com')
    expect(canonicalMailbox('+x@acme.com')).toBe('+x@acme.com')
    expect(canonicalMailbox('not an address')).toBe('not an address')
  })
  it('without a key the hashes are plain SHA-256 of the typed and canonical forms', async () => {
    const h = await suppressionHashes({}, 'Bob+x@Gmail.com')
    expect(h.write).toEqual([sha('bob+x@gmail.com'), sha('bob@gmail.com')])
    expect(h.read).toEqual(h.write)
  })
  it('with a key, new entries are HMACs; lookups also accept the plain form and the previous key', async () => {
    const h = await suppressionHashes({ SUPPRESSION_HASH_KEY: 'k1', SUPPRESSION_HASH_KEY_PREVIOUS: 'k0' }, 'bob@acme.com')
    expect(h.write).toEqual([createHmac('sha256', 'k1').update('bob@acme.com').digest('hex')])
    expect(h.read).toEqual(expect.arrayContaining([h.write[0], createHmac('sha256', 'k0').update('bob@acme.com').digest('hex'), sha('bob@acme.com')]))
    expect(h.write[0]).not.toBe(sha('bob@acme.com'))
  })
})

describe('G1 — an alias of a removed mailbox is the same removed mailbox', () => {
  it('removing dana@gmail.com also blocks dana+x@gmail.com and d.a.n.a@googlemail.com on the public form', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@gmail.com' })] })
    await call(t.mod.removeLead, { token: await tokenFor('remove', 'dana@gmail.com') })
    for (const email of ['dana+x@gmail.com', 'd.a.n.a@googlemail.com']) await submit({ name: 'Dana', company: 'Acme', email })
    expect(t.state.leads).toHaveLength(0)
  })
  it('removing an alias deletes the lead stored under the plain address', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@gmail.com' })] })
    await call(t.mod.removeLead, { token: await tokenFor('remove', 'dana+old@gmail.com') })
    expect(t.state.leads).toHaveLength(0)
  })
  it('an import never puts back an alias of a removed mailbox', async () => {
    t = setup({ suppressed: [sha('dana@gmail.com')] })
    const res = await call(t.mod.adminImportLeads, { rows: [{ name: 'Dana', company: 'Acme', email: 'dana+import@gmail.com' }], attest: true })
    expect(res.body.data).toMatchObject({ created: 0, removed: 1 })
  })
  it('the candidates notice skips an address whose alias opted out', async () => {
    t = setup({ supply: [{ role_category: 'sales', candidate_count: '3' }], suppressed: [sha('dana@gmail.com')],
      leads: [mkLead({ email: 'dana+jobs@gmail.com', role_category: 'sales', confirmed_at: '2026-02-01T00:00:00.000Z' })] })
    const res = await call(t.mod.adminNotifyCandidates, { field: 'sales' })
    expect(t.state.candidateMails).toHaveLength(0)
    expect(res.body.data).toMatchObject({ sent: 0, skipped: 1 })
  })
})

describe('G8 — the do-not-contact list can be keyed', () => {
  const key = { SUPPRESSION_HASH_KEY: 'secret-key' }
  it('records a keyed hash (never the plain SHA-256)', async () => {
    t = setup({ envExtra: key, leads: [mkLead({ email: 'dana@acme.com' })] })
    await call(t.mod.removeLead, { token: await tokenFor('remove', 'dana@acme.com') })
    expect(t.state.suppressed.has(createHmac('sha256', 'secret-key').update('dana@acme.com').digest('hex'))).toBe(true)
    expect(t.state.suppressed.has(sha('dana@acme.com'))).toBe(false)
  })
  it('still honours an entry written before the key existed', async () => {
    t = setup({ envExtra: key, suppressed: [sha('old@acme.com')] })
    await submit({ name: 'O', company: 'Acme', email: 'old@acme.com' })
    expect(t.state.leads).toHaveLength(0)
  })
})

describe('G3 — the bounce / complaint block is visible and can be lifted from the leads screen', () => {
  const block = (email, reason = 'bounce') => { t.state.mailBlocks = new Map([[sha(email), { reason, created_at: '2026-02-02T00:00:00.000Z' }]]) }
  it('the lookup reports it', async () => {
    t = setup(); block('dana@acme.com', 'complaint')
    const res = await call(t.mod.adminCheckSuppression, { email: 'dana@acme.com' })
    expect(res.body.data).toMatchObject({ suppressed: false, mailSuppression: { reason: 'complaint', since: '2026-02-02T00:00:00.000Z' } })
  })
  it('the lookup reports the list entry with why it exists', async () => {
    t = setup({ suppressed: [sha('dana@acme.com')] })
    t.state.reasons = new Map([[sha('dana@acme.com'), 'self']])
    const res = await call(t.mod.adminCheckSuppression, { email: 'dana@acme.com' })
    expect(res.body.data).toMatchObject({ suppressed: true, reason: 'self', mailSuppression: null })
  })
  it('lifts the mail block only when asked, even when the address is not on the list', async () => {
    t = setup(); block('dana@acme.com')
    expect((await call(t.mod.adminLiftSuppression, { email: 'dana@acme.com' })).status).toBe(404)
    const both = await call(t.mod.adminLiftSuppression, { email: 'dana@acme.com', includeMailSuppression: true })
    expect(both.body).toMatchObject({ success: true, data: { listLifted: false, mailLifted: true } })
    expect(t.state.mailBlocks.size).toBe(0)
    expect(t.state.audit.find(a => a.action === 'lead.suppression_lift').detail).toEqual({ list: false, mail: true })
  })
})

describe('G4 — a person who removed themselves can come back', () => {
  const rejoin = async (email, extra = {}) => call(t.mod.rejoinLead, { token: await tokenFor('rejoin', email), name: 'Dana', company: 'Acme', ...extra })
  const removedSelf = async (email = 'dana@acme.com') => {
    t = setup({ leads: [mkLead({ email })] })
    await call(t.mod.removeLead, { token: await tokenFor('remove', email) })
  }
  it('removal by the person records why; the public form then sends a rejoin offer', async () => {
    await removedSelf()
    expect([...t.state.reasons.values()]).toEqual(['self'])
    const res = await submit({ name: 'Dana', company: 'Acme', email: 'dana@acme.com' })
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
    expect(t.state.rejoins).toHaveLength(1)
    expect(t.state.rejoins[0].links.rejoinUrl).toMatch(/^https:\/\/passthrough\.dev\/employer\/rejoin\?token=/)
    expect(t.state.rejoins[0].links.removeUrl).toMatch(/\/employer\/remove\?token=/)
  })
  it('an admin block, a complaint, a bounce or an entry of unknown origin is never offered a way back', async () => {
    for (const reason of ['admin', 'complaint', 'bounce', null]) {
      t = setup({ suppressed: [sha('dana@acme.com')] }); t.state.reasons = new Map([[sha('dana@acme.com'), reason]])
      await submit({ name: 'Dana', company: 'Acme', email: 'dana@acme.com' })
      expect(t.state.rejoins || []).toHaveLength(0)
      expect((await rejoin('dana@acme.com')).body.status).toBe('unavailable')
      expect(t.state.leads).toHaveLength(0)
      t.restore()
    }
  })
  it('following the link adds a confirmed lead, lifts the block, and audits it by hash', async () => {
    await removedSelf()
    const res = await rejoin('dana@acme.com', { field: 'sales' })
    expect(res.body).toMatchObject({ success: true, status: 'joined' })
    expect(t.state.leads[0]).toMatchObject({ email: 'dana@acme.com', role_category: 'sales', source: 'rejoin', confirmed_via: 'rejoin', status: 'NEW' })
    expect(t.state.leads[0].confirmed_at).toBeTruthy()
    expect(t.state.leads[0].consent).toMatchObject({ kind: 'rejoin' })
    expect(t.state.suppressed.size).toBe(0)
    expect(t.state.audit.find(a => a.action === 'lead.rejoin')).toBeTruthy()
    expect(JSON.stringify(t.state.audit)).not.toContain('dana@acme.com')
  })
  it('is safe to follow twice, and refuses other links', async () => {
    await removedSelf()
    await rejoin('dana@acme.com')
    expect((await rejoin('dana@acme.com')).body.status).toBe('already')
    expect(t.state.leads).toHaveLength(1)
    expect((await call(t.mod.rejoinLead, { token: await tokenFor('confirm', 'dana@acme.com'), name: 'D', company: 'A' })).status).toBe(400)
    expect((await call(t.mod.rejoinLead, { token: 'x'.repeat(40), name: 'D', company: 'A' })).status).toBe(400)
  })
  it('does not add an address that has since bounced or complained (global block)', async () => {
    await removedSelf()
    t.state.mailBlocks = new Map([[sha('dana@acme.com'), { reason: 'bounce', created_at: '2026-02-02T00:00:00.000Z' }]])
    expect((await rejoin('dana@acme.com')).body.status).toBe('unavailable')
    expect(t.state.leads).toHaveLength(0)
  })
  it('a stronger reason (a complaint after removing yourself) closes the way back', async () => {
    await removedSelf()
    await t.mod.performRemoval(t.db, 'dana@acme.com', { env: t.env, reason: 'complaint' })
    expect([...t.state.reasons.values()]).toEqual(['complaint'])
  })
})

describe('G5 — a bulk action can cover everything the list matches', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => mkLead({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, email: `p${i}@acme.com` }))
  it('acts on every matching lead, in chunks, with one aggregate audit entry', async () => {
    t = setup({ leads: many(230) })
    const res = await call(t.mod.adminBulkUpdateLeads, { filter: { status: 'NEW' }, expected: 230, action: 'markConfirmed' })
    expect(res.body).toMatchObject({ success: true, affected: 230, matched: 230 })
    expect(t.state.leads.every(l => l.confirmed_at && l.confirmed_via === 'admin')).toBe(true)
    const entries = t.state.audit.filter(a => a.action === 'lead.bulk_mark_confirmed')
    expect(entries).toHaveLength(1)
    expect(entries[0].detail).toMatchObject({ filtered: true, matched: 230 })
  })
  it('refuses when the list changed since the admin looked (409) and changes nothing', async () => {
    t = setup({ leads: many(5) })
    const stale = await call(t.mod.adminBulkUpdateLeads, { filter: { status: 'NEW' }, expected: 9, action: 'markConfirmed' })
    expect(stale.status).toBe(409)
    expect(t.state.leads.some(l => l.confirmed_at)).toBe(false)
  })
  it('never sends confirmation emails to a filter, and needs exactly one of ids / filter', async () => {
    t = setup({ leads: many(3) })
    await expect(call(t.mod.adminBulkUpdateLeads, { filter: {}, expected: 3, action: 'requestConfirmation' })).rejects.toBeTruthy()
    await expect(call(t.mod.adminBulkUpdateLeads, { action: 'markConfirmed' })).rejects.toBeTruthy()
    await expect(call(t.mod.adminBulkUpdateLeads, { ids: [ID1], filter: {}, expected: 1, action: 'markConfirmed' })).rejects.toBeTruthy()
  })
})

describe('B3 — bulk setField is one statement', () => {
  it('goes through set_lead_field once for the whole selection and audits it', async () => {
    t = setup({ leads: [mkLead({ id: ID1, email: 'a@x.com', extra_role_categories: ['sales'] }), mkLead({ id: ID2, email: 'b@x.com' })] })
    const res = await call(t.mod.adminBulkUpdateLeads, { ids: [ID1, ID2], action: 'setField', field: 'sales' })
    expect(res.body).toMatchObject({ success: true, affected: 2 })
    const rpcs = t.db.calls.filter(q => q.op === 'rpc' && q.name === 'set_lead_field')
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].args).toEqual({ p_ids: [ID1, ID2], p_field: 'sales' })
    expect(t.state.leads.map(l => l.extra_role_categories)).toEqual([[], []])
  })
  it('a failing statement changes nothing', async () => {
    t = setup({ leads: [mkLead({ id: ID1 })] })
    const real = t.db.rpc
    t.db.rpc = (name, args) => name === 'set_lead_field' ? Promise.resolve({ data: null, error: { message: 'boom' } }) : real(name, args)
    await expect(call(t.mod.adminBulkUpdateLeads, { ids: [ID1], action: 'setField', field: 'sales' })).rejects.toBeTruthy()
    expect(t.state.leads[0].role_category).toBeNull()
  })
})

describe('B1 — the confirm page can only FILL a missing field', () => {
  const setField = async (email, field) => call(t.mod.setLeadField, { token: await tokenFor('confirm', email), field })
  it('saves a field on a lead that has none', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' })] })
    expect((await setField('dana@acme.com', 'sales')).body.status).toBe('saved')
    expect(t.state.leads[0].role_category).toBe('sales')
  })
  it('never overwrites a field the lead already has (and says so)', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com', role_category: 'finance', extra_role_categories: ['sales'] })] })
    expect((await setField('dana@acme.com', 'sales')).body.status).toBe('already')
    expect(t.state.leads[0]).toMatchObject({ role_category: 'finance', extra_role_categories: ['sales'] })
  })
  it('reports a lead that no longer exists', async () => {
    t = setup()
    expect((await setField('gone@acme.com', 'sales')).body.status).toBe('not_found')
  })
})

describe('G6 — "already told" is tracked per field', () => {
  const supply = [{ role_category: 'sales', candidate_count: '3' }, { role_category: 'finance', candidate_count: '2' }]
  const lead = (over = {}) => mkLead({ email: 'dana@acme.com', role_category: 'sales', extra_role_categories: ['finance'], confirmed_at: '2026-02-01T00:00:00.000Z', candidates_notified_fields: {}, ...over })
  it('a lead hiring in two fields is told about each, one field at a time', async () => {
    t = setup({ supply, leads: [lead()] })
    expect((await call(t.mod.adminNotifyCandidates, { field: 'sales' })).body.data).toMatchObject({ sent: 1 })
    expect(Object.keys(t.state.leads[0].candidates_notified_fields)).toEqual(['sales'])
    expect((await call(t.mod.adminNotifyCandidates, { field: 'sales' })).body.data).toMatchObject({ sent: 0, eligible: 0 })
    expect((await call(t.mod.adminNotifyCandidates, { field: 'finance' })).body.data).toMatchObject({ sent: 1 })
    expect(Object.keys(t.state.leads[0].candidates_notified_fields).sort()).toEqual(['finance', 'sales'])
    expect(t.state.candidateMails.map(m => m.links.fieldKey)).toEqual(['sales', 'finance'])
  })
  it('an admin can add a lead with other fields; the main field must come first', async () => {
    t = setup()
    const made = await call(t.mod.adminCreateLead, { name: 'Dana', company: 'Acme', email: 'dana@acme.com', roleCategory: 'sales', extraRoleCategories: ['finance', 'design'] })
    expect(made.status).toBe(201)
    expect(t.state.leads[0].extra_role_categories).toEqual(['finance', 'design'])
    await expect(call(t.mod.adminCreateLead, { name: 'X', company: 'Y', email: 'x@y.com', extraRoleCategories: ['finance'] })).rejects.toBeTruthy()
  })
})

describe('G7 — every lead records how it came to be mailable', () => {
  it('a form submission keeps what it agreed to and where', async () => {
    t = setup()
    await submit({ name: 'Dana', company: 'Acme', email: 'dana@acme.com', source: 'homepage' })
    expect(t.state.leads[0].consent).toMatchObject({ kind: 'form', v: 1, source: 'homepage' })
  })
  it('the confirm link, an admin, a manual add and an import each leave their own mark', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@acme.com' }), mkLead({ id: ID2, email: 'b@acme.com' })] })
    await call(t.mod.confirmLead, { token: await tokenFor('confirm', 'dana@acme.com') })
    expect(t.state.leads[0].confirmed_via).toBe('link')
    await t.mod.adminMarkConfirmed(t.c({ params: { id: ID2 } }))
    expect(t.state.leads[1].confirmed_via).toBe('admin')
    await call(t.mod.adminCreateLead, { name: 'M', company: 'C', email: 'm@acme.com' })
    expect(t.state.leads.find(l => l.email === 'm@acme.com')).toMatchObject({ confirmed_via: 'manual', consent: { kind: 'manual', by: 'admin-1' } })
    await call(t.mod.adminImportLeads, { rows: [{ name: 'I', company: 'C', email: 'i@acme.com' }], attest: true })
    expect(t.state.leads.find(l => l.email === 'i@acme.com')).toMatchObject({ confirmed_via: 'import', consent: { kind: 'import', by: 'admin-1', attested: true } })
  })
  it('the form still captures a lead before migration 0068 has run (new columns dropped and retried)', async () => {
    t = setup()
    const real = t.db.from
    t.db.from = (table) => {
      const api = real(table)
      if (table !== 'employer_leads') return api
      const ins = api.insert
      api.insert = (v) => {
        if ([].concat(v).some(r => 'consent' in r || 'confirmed_via' in r)) {
          const r = Promise.resolve({ error: { code: '42703', message: 'no column' } })
          const a2 = { select: () => a2, then: (res, rej) => r.then(res, rej) }
          return a2
        }
        return ins(v)
      }
      return api
    }
    await submit({ name: 'Dana', company: 'Acme', email: 'dana@acme.com' })
    expect(t.state.leads).toHaveLength(1)
    expect(t.state.leads[0].consent).toBeUndefined()
  })
  it('the CSV exports the new columns at the end', async () => {
    t = setup({ leads: [mkLead({ confirmed_via: 'link', consent: { kind: 'form', at: '2026-01-01T00:00:00.000Z' }, candidates_notified_fields: { sales: '2026-03-01T00:00:00.000Z' } })] })
    const res = await t.mod.adminExportLeads(t.c({}))
    const [header, line] = res.raw.replace('﻿', '').split('\r\n')
    expect(header.endsWith('"Candidates notified by field","Confirmed via","Consent"')).toBe(true)
    expect(line.endsWith('"sales: 2026-03-01T00:00:00.000Z","link","form 2026-01-01T00:00:00.000Z"')).toBe(true)
  })
})

describe('G9 — the hourly retry keeps the one-click unsubscribe header', () => {
  const old = '2026-01-01T00:00:00.000Z'
  const NOW = Date.parse('2026-01-02T00:00:00.000Z')
  it('uses the origin a real request carried', async () => {
    t = setup({ kv: { 'leads:api-origin': 'https://api.passthrough.dev' }, leads: [mkLead({ email: 'a@acme.com', created_at: old, ack_attempts: 0, last_ack_at: null, confirmed_at: null })] })
    await t.mod.sweepUnacknowledgedLeads(t.env, t.db, NOW)
    expect(t.state.ackLinks[0].unsubscribeUrl).toMatch(/^https:\/\/api\.passthrough\.dev\/api\/employer-leads\/unsubscribe\?token=/)
  })
  it('prefers API_ORIGIN', async () => {
    t = setup({ envExtra: { API_ORIGIN: 'https://edge.example.dev/' }, leads: [mkLead({ email: 'a@acme.com', created_at: old, ack_attempts: 0, last_ack_at: null, confirmed_at: null })] })
    await t.mod.sweepUnacknowledgedLeads(t.env, t.db, NOW)
    expect(t.state.ackLinks[0].unsubscribeUrl).toMatch(/^https:\/\/edge\.example\.dev\/api\//)
  })
  it('ignores a remembered origin that is not under the frontend domain', async () => {
    t = setup({ kv: { 'leads:api-origin': 'https://evil.example.com' }, leads: [mkLead({ email: 'a@acme.com', created_at: old, ack_attempts: 0, last_ack_at: null, confirmed_at: null })] })
    await t.mod.sweepUnacknowledgedLeads(t.env, t.db, NOW)
    expect(t.state.ackLinks[0].unsubscribeUrl ?? null).toBeNull()
  })
  it('a request that carries an https origin under the frontend domain remembers it', async () => {
    t = setup()
    const ctx = t.c({ body: { name: 'D', company: 'A', email: 'd@acme.com' } })
    ctx.req.url = 'https://api.passthrough.dev/api/employer-leads'
    await t.mod.createLead(ctx); await Promise.all(ctx._waits)
    expect(t.state.kv['leads:api-origin']).toBe('https://api.passthrough.dev')
  })
  it('an address that bounced is closed out at once instead of retried every six hours', async () => {
    t = setup({ ackResult: 'suppressed', leads: [mkLead({ email: 'a@acme.com', created_at: old, ack_attempts: 0, last_ack_at: null, confirmed_at: null })] })
    const out = await t.mod.sweepUnacknowledgedLeads(t.env, t.db, NOW)
    expect(out).toMatchObject({ sent: 0, failed: 0, blocked: 1 })
    expect(t.state.leads[0].ack_attempts).toBeGreaterThanOrEqual(3)
  })
})

describe('B7 — the export is produced page by page', () => {
  it('hands back a stream, reads only the first page before answering, and states the expected count', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => mkLead({ id: `id-${i}`, email: `e${i}@x.com`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` }))
    t = setup({ leads: rows })
    let captured
    const ctx = t.c({}); ctx.body = (b, s, h) => { captured = { b, h }; return { status: s } }
    await t.mod.adminExportLeads(ctx)
    expect(captured.b).toBeInstanceOf(ReadableStream)
    expect(captured.h['X-Export-Rows']).toBe('5')
    expect(captured.h['X-Export-Truncated']).toBe('false')
    expect(t.db.calls.filter(q => q.table === 'employer_leads' && q.op === 'select' && !q.selectOpts?.head)).toHaveLength(1)
    expect(t.state.audit.some(a => a.action === 'lead.export' && a.detail.rows === 5)).toBe(true)
  })
})

describe('retention records the reason', () => {
  it('an archived-lead purge writes keyed hashes with reason "purge" and falls back when the column is missing', async () => {
    const { purgeArchivedLeads } = await import('../src/services/retention.service.js')
    const upserts = []
    let failFirst = true
    const db = createFakeSupabase(q => {
      if (q.table === 'employer_leads') return { data: [{ id: '1', email: 'Dana+x@gmail.com' }], error: null }
      if (q.table === 'employer_lead_suppressions') { upserts.push(q.values); if (failFirst) { failFirst = false; return { error: { code: '42703', message: 'no reason' } } } return { data: null, error: null } }
      return { data: null, error: null }
    })
    const r = await purgeArchivedLeads(db, Date.now(), { suppress: true, env: { SUPPRESSION_HASH_KEY: 'k' } })
    expect(r).toMatchObject({ deleted: 1, suppressed: 1 })
    expect(upserts[0].every(v => v.reason === 'purge')).toBe(true)
    expect(upserts[1].every(v => !('reason' in v))).toBe(true)
    expect(upserts[1]).toHaveLength(2)
    expect(upserts[1][0].email_hash).toBe(createHmac('sha256', 'k').update('dana+x@gmail.com').digest('hex'))
  })
})
