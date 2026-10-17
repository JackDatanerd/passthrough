import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Employer leads, round 12 (independent audit of Section 5): alias-safe removal (B1), the acknowledgement sweep and
// notify-candidates no longer stall on do-not-contact leads (B2/B3), the lead detail view (G1/G2), the "update my
// details" link (G3). A compact in-memory fake of just the tables these paths touch.

const SECRET = 'test-secret-'.padEnd(40, 'x')
const sha = (e) => createHash('sha256').update(e).digest('hex')
const { canonicalMailbox } = await import('../src/lib/mailbox.js')
const { signLeadToken } = await import('../src/lib/leadTokens.js')

let n = 0
const mkLead = (over = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, name: 'A', company: 'B', email: 'a@b.com', status: 'NEW',
  notes: null, contacted_at: null, role_category: 'sales', role_title: null, source: 'homepage', submission_count: 1,
  extra_role_categories: [], candidates_notified_fields: {}, confirmed_at: '2026-01-01T00:00:00.000Z',
  created_at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, last_submitted_at: '2026-01-01T00:00:00.000Z', ...over,
})

function setup({ leads = [], suppressed = {}, logs = [], supply = [{ role_category: 'sales', candidate_count: 3 }], mailBlocks = {}, noMailboxKey = false } = {}) {
  const state = { leads: leads.map(l => ({ ...l })), reasons: new Map(Object.entries(suppressed).map(([e, r]) => [sha(e), r])),
    acks: [], candidateMails: [], logPurges: [], audit: [] }
  const keyOf = (r) => canonicalMailbox(r.email)
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      const rows = state.leads
      const match = (r) => q.filters.every(([op, col, val]) => {
        if (col === 'mailbox_key' && noMailboxKey) return true
        const v = col === 'mailbox_key' ? keyOf(r) : r[col]
        if (op === 'eq') return v === val
        if (op === 'neq') return v !== val
        if (op === 'in') return val.includes(v)
        if (op === 'is') return (v ?? null) === val
        if (op === 'gte') return v >= val
        return true
      })
      if (q.op === 'delete') {
        if (noMailboxKey && q.filters.some(f => f[1] === 'mailbox_key')) return { data: null, error: { code: '42703', message: 'no such column' } }
        const hit = rows.filter(match); hit.forEach(r => rows.splice(rows.indexOf(r), 1))
        return { data: hit.map(r => ({ id: r.id, email: r.email })), error: null }
      }
      if (q.op === 'update') {
        const hit = rows.filter(match); hit.forEach(r => Object.assign(r, q.patch))
        return { data: q.maybe || q.single ? (hit[0] ? { ...hit[0] } : null) : hit.map(r => ({ ...r })), error: null }
      }
      if (q.selectOpts?.head) return { count: rows.filter(match).length, error: null }
      if (q.maybe) { const r = rows.find(match); return { data: r ? { ...r } : null, error: null } }
      // the notify scan's keyset cursor (round 14): created_at.gt.X,and(created_at.eq.X,id.gt.Y)
      const after = (q.or || []).map(e => /^created_at\.gt\.(.+),and\(created_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(e)).find(Boolean)
      const keyset = (r) => !after || r.created_at > after[1] || (r.created_at === after[2] && r.id > after[3])
      const hit = rows.filter(match).filter(keyset).sort((x, y) => x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : x.id < y.id ? -1 : 1)
      return { data: hit.slice(0, q.limit || undefined).map(r => ({ ...r })), count: hit.length, error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      const hs = [].concat(q.filters.find(f => f[1] === 'email_hash')?.[2] || [])
      if (q.op === 'upsert') { [].concat(q.values).forEach(v => { if (!state.reasons.has(v.email_hash)) state.reasons.set(v.email_hash, v.reason ?? null) }); return { data: null, error: null } }
      if (q.op === 'update') return { data: null, error: null }
      if (q.op === 'delete') { hs.forEach(h => state.reasons.delete(h)); return { data: [], error: null } }
      if (q.selectOpts?.head) return { count: state.reasons.size, error: null }
      return { data: hs.filter(h => state.reasons.has(h)).map(h => ({ email_hash: h, reason: state.reasons.get(h), created_at: '2026-01-01T00:00:00.000Z' })), error: null }
    }
    if (q.table === 'email_suppressions') {
      const f = q.filters.find(x => x[1] === 'email_hash')
      const hs = f?.[0] === 'in' ? f[2] : [f?.[2]]   // round 14: lookups are `in (every hash form)`
      return { data: hs.filter(h => mailBlocks[h]).map(h => ({ email_hash: h, ...mailBlocks[h] })), error: null }
    }
    if (q.table === 'admin_audit_log') { state.audit.push(q.values); return { data: null, error: null } }
    if (q.table === 'email_logs') {
      if (q.op === 'delete') { state.logPurges.push(q.filters.map(f => f[2])); return { data: null, error: null } }
      return { data: logs, error: null }
    }
    if (q.op === 'rpc' && q.name === 'verified_candidate_counts') return { data: supply, error: null }
    return undefined
  })
  const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': {
      sendOwnerNotice: async () => {}, sendOwnerAlert: async () => {},
      sendEmployerLeadAck: async (env, sb, to, name, field, links) => { state.acks.push({ to, links }); return true },
      sendEmployerCandidatesAvailable: async (env, sb, to, name, field, count, links) => { state.candidateMails.push({ to, links }); return true },
    },
  })
  const env = { RATE_LIMIT_KV: { get: async () => null, put: async () => {} }, JWT_SECRET: SECRET, FRONTEND_URL: 'https://usepassthrough.com' }
  const c = (over = {}) => ({
    env, get: (k) => k === 'user' ? { id: 'admin-1', role: 'ADMIN' } : undefined, executionCtx: { waitUntil: () => {} },
    req: { json: async () => over.body, param: k => (over.params || {})[k], query: k => (over.query || {})[k] },
    json: (body, status = 200) => ({ body, status }),
  })
  return { mod, restore, state, db, c, env }
}

let t, realErr, realWarn
beforeEach(() => { realErr = console.error; realWarn = console.warn; console.error = () => {}; console.warn = () => {} })
afterEach(() => { console.error = realErr; console.warn = realWarn; t?.restore() })
const tok = (purpose, email) => signLeadToken(SECRET, purpose, email)

describe('lead_mailbox_key (migration 0076) matches canonicalMailbox', () => {
  const pairs = JSON.parse(readFileSync(new URL('./fixtures/mailbox-keys.json', import.meta.url), 'utf8'))
  it('has a fixture of pairs, each reproduced by the JS implementation', () => {
    expect(pairs.length).toBeGreaterThan(10)
    for (const [email, key] of pairs) expect(canonicalMailbox(email)).toBe(key)
  })
})

describe('B1 — removing an inbox removes every spelling of it', () => {
  it('a self-removal deletes the lead stored as dana+jobs@gmail.com and purges its logs', async () => {
    t = setup({ leads: [mkLead({ email: 'dana@gmail.com' }), mkLead({ email: 'dana+jobs@gmail.com' }), mkLead({ email: 'd.a.n.a@gmail.com' }), mkLead({ email: 'other@gmail.com' })] })
    const res = await t.mod.removeLead(t.c({ body: { token: await tok('remove', 'dana@gmail.com') } }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads.map(l => l.email)).toEqual(['other@gmail.com'])
    expect(JSON.stringify(t.state.logPurges)).toContain('dana+jobs@gmail.com')
  })
  it('before migration 0076 it still removes the exact address and does not fail', async () => {
    t = setup({ noMailboxKey: true, leads: [mkLead({ email: 'dana@gmail.com' })] })
    const res = await t.mod.removeLead(t.c({ body: { token: await tok('remove', 'dana@gmail.com') } }))
    expect(res.body.success).toBe(true)
    expect(t.state.leads).toHaveLength(0)
  })
  it('an admin do-not-contact entry removes the alias leads too and says so', async () => {
    t = setup({ leads: [mkLead({ email: 'x@acme.com' }), mkLead({ email: 'x+y@acme.com' })] })
    await t.mod.adminAddSuppression(t.c({ body: { email: 'x@acme.com' } }))
    expect(t.state.leads).toHaveLength(0)
  })
})

describe('B2 — the acknowledgement sweep clears do-not-contact leads out of its queue', () => {
  const old = (over) => mkLead({ confirmed_at: null, ack_attempts: 0, created_at: '2026-01-01T00:00:00.000Z', ...over })
  it('deletes a lead whose address removed itself, and closes out an admin-suppressed one', async () => {
    const gone = old({ email: 'gone@acme.com' }), blocked = old({ email: 'blocked@acme.com' }), fine = old({ email: 'fine@acme.com' })
    t = setup({ leads: [gone, blocked, fine], suppressed: { 'gone@acme.com': 'self', 'blocked@acme.com': 'admin' } })
    const out = await t.mod.sweepUnacknowledgedLeads(t.env, t.db, Date.parse('2026-01-02T00:00:00.000Z'))
    expect(out).toMatchObject({ removed: 1, suppressed: 1, sent: 1 })
    expect(t.state.leads.find(l => l.email === 'gone@acme.com')).toBeUndefined()
    expect(t.state.leads.find(l => l.email === 'blocked@acme.com').ack_attempts).toBeGreaterThanOrEqual(1)
    expect(t.state.acks.map(a => a.to)).toEqual(['fine@acme.com'])
  })
})

describe('B3 — notify-candidates reaches past do-not-contact leads', () => {
  it('deletes removal-request leads, skips other suppressed ones, mails the rest', async () => {
    t = setup({
      leads: [mkLead({ email: 'gone@acme.com' }), mkLead({ email: 'blocked@acme.com' }), mkLead({ email: 'fine@acme.com' })],
      suppressed: { 'gone@acme.com': 'self', 'blocked@acme.com': 'admin' }
    })
    const res = await t.mod.adminNotifyCandidates(t.c({ body: { field: 'sales' } }))
    expect(res.body.data).toMatchObject({ sent: 1, removed: 1, skipped: 1 })
    expect(t.state.candidateMails.map(m => m.to)).toEqual(['fine@acme.com'])
    expect(t.state.candidateMails[0].links.prefsUrl).toContain('/employer/preferences?token=')
  })
  it('walks past a full window of unmailable leads to reach the ones behind them', async () => {
    const blocked = Array.from({ length: 120 }, (_, i) => mkLead({ email: `b${i}@acme.com`, created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` }))
    const suppressed = Object.fromEntries(blocked.map(l => [l.email, 'admin']))
    t = setup({ leads: [...blocked, mkLead({ email: 'late@acme.com', created_at: '2026-06-01T00:00:00.000Z' })], suppressed })
    const res = await t.mod.adminNotifyCandidates(t.c({ body: { field: 'sales' } }))
    expect(res.body.data).toMatchObject({ sent: 1, skipped: 120 })
    expect(t.state.candidateMails.map(m => m.to)).toEqual(['late@acme.com'])
  })
  it('dry run counts but never deletes or sends', async () => {
    t = setup({ leads: [mkLead({ email: 'gone@acme.com' }), mkLead({ email: 'fine@acme.com' })], suppressed: { 'gone@acme.com': 'self' } })
    const res = await t.mod.adminNotifyCandidates(t.c({ body: { field: 'sales', dryRun: true } }))
    expect(res.body.data).toMatchObject({ dryRun: true, eligible: 1, sent: 0 })
    expect(t.state.leads).toHaveLength(2)
    expect(t.state.candidateMails).toHaveLength(0)
  })
})

describe('G1/G2 — lead detail and the do-not-contact flag in the list', () => {
  it('GET /:id returns the lead, its do-not-contact state, mail history and same-inbox leads', async () => {
    const a = mkLead({ email: 'dana@gmail.com' }), b = mkLead({ email: 'dana+x@gmail.com' })
    t = setup({ leads: [a, b], suppressed: { 'dana@gmail.com': 'admin' }, logs: [{ template: 'employer_lead_ack', subject: 'Confirm', status: 'sent', sent_at: '2026-01-02T00:00:00.000Z' }] })
    const res = await t.mod.adminGetLead(t.c({ params: { id: a.id } }))
    expect(res.status).toBe(200)
    expect(res.body.data.lead.email).toBe('dana@gmail.com')
    expect(res.body.data.doNotContact).toMatchObject({ suppressed: true, reason: 'admin' })
    expect(res.body.data.emails).toEqual([{ template: 'employer_lead_ack', subject: 'Confirm', status: 'sent', sentAt: '2026-01-02T00:00:00.000Z' }])
    expect(res.body.data.sameInbox.map(r => r.id)).toEqual([b.id])
  })
  it('404s for an unknown id', async () => {
    t = setup()
    const res = await t.mod.adminGetLead(t.c({ params: { id: '99999999-9999-4999-8999-999999999999' } }))
    expect(res.status).toBe(404)
  })
  it('the list flags rows whose address is on the do-not-contact list', async () => {
    t = setup({ leads: [mkLead({ email: 'blocked@acme.com' }), mkLead({ email: 'fine@acme.com' })], suppressed: { 'blocked@acme.com': 'admin' } })
    const res = await t.mod.adminListLeads(t.c())
    const flags = Object.fromEntries(res.body.data.map(r => [r.email, r.doNotContact]))
    expect(flags).toEqual({ 'blocked@acme.com': true, 'fine@acme.com': false })
  })
})

describe('G3 — "update my details"', () => {
  it('loads and saves field, other fields and job title with a prefs token — and only that purpose works', async () => {
    const lead = mkLead({ email: 'dana@acme.com', role_category: 'sales', name: 'Dana', company: 'Acme' })
    t = setup({ leads: [lead] })
    const token = await tok('prefs', 'dana@acme.com')
    const loaded = await t.mod.loadLeadPreferences(t.c({ body: { token } }))
    expect(loaded.body.data).toMatchObject({ field: 'sales', extraFields: [], roleTitle: '' })
    const saved = await t.mod.saveLeadPreferences(t.c({ body: { token, field: 'design', extraFields: ['sales', 'design'], roleTitle: ' Head of Talent ' } }))
    expect(saved.body.status).toBe('saved')
    expect(t.state.leads[0]).toMatchObject({ role_category: 'design', extra_role_categories: ['sales'], role_title: 'Head of Talent', name: 'Dana', company: 'Acme' })
    for (const purpose of ['confirm', 'remove', 'rejoin']) {
      const bad = await t.mod.saveLeadPreferences(t.c({ body: { token: await tok(purpose, 'dana@acme.com'), field: 'sales' } }))
      expect(bad.status).toBe(400)
    }
  })
  it('says not_found when the lead is gone', async () => {
    t = setup()
    const res = await t.mod.loadLeadPreferences(t.c({ body: { token: await tok('prefs', 'nobody@acme.com') } }))
    expect(res.body.status).toBe('not_found')
  })
})
