import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createFakeSupabase } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// Round 14 (Section 5): notify vs same-inbox duplicates, notify scan over tied created_at, merge status rank,
// and step-up on the writes that can lift a do-not-contact entry.

const { sha256 } = await import('../src/lib/crypto.js')
const TS = '2026-01-01T00:00:00.000Z'
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const mk = (id, email, over = {}) => ({ id, name: 'N', company: 'B', email, status: 'NEW', notes: null, contacted_at: null,
  role_category: 'sales', role_title: null, source: 'homepage', submission_count: 1, extra_role_categories: [],
  candidates_notified_fields: {}, confirmed_at: TS, created_at: TS, updated_at: TS, last_submitted_at: TS, ...over })
const ENV = { RATE_LIMIT_KV: { get: async () => null, put: async () => {} }, JWT_SECRET: 'x'.repeat(40), FRONTEND_URL: 'https://passthrough.dev' }
const ctx = (body) => ({ env: ENV, get: () => ({ id: 'admin' }), executionCtx: { waitUntil: () => {} },
  req: { json: async () => body, param: () => undefined, query: () => undefined }, json: (b, s = 200) => ({ b, s }) })

// Shared fake: employer_leads with keyset + sibling lookup, email_logs filtered by `to`, optional suppression hashes.
function notifyEnv({ leads, logs = [], blocked = new Set(), mailResult }) {
  const db = createFakeSupabase(q => {
    if (q.table === 'employer_leads') {
      if (q.op === 'update') { const id = q.filters.find(f => f[1] === 'id')?.[2]; const r = leads.find(l => l.id === id); if (r) Object.assign(r, q.patch); return { data: null, error: null } }
      const mb = q.filters.find(f => f[1] === 'mailbox_key')
      if (mb) return { data: leads.filter(l => l.email.replace(/\+[^@]*/, '') === mb[2]).map(l => ({ email: l.email })), error: null }
      let rows = leads.filter(r => !(r.candidates_notified_fields || {}).sales)
      const after = (q.or || []).map(e => /^created_at\.gt\.(.+),and\(created_at\.eq\.(.+),id\.gt\.(.+)\)$/.exec(e)).find(Boolean)
      if (after) rows = rows.filter(r => r.created_at > after[1] || (r.created_at === after[2] && r.id > after[3]))
      rows = rows.sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)
      return { data: rows.slice(0, q.limit || undefined).map(r => ({ ...r })), count: rows.length, error: null }
    }
    if (q.table === 'email_logs') {
      const to = q.filters.find(f => f[0] === 'in' && f[1] === 'to')?.[2] || []
      return { data: logs.filter(l => to.includes(l.to)), error: null }
    }
    if (q.table === 'employer_lead_suppressions') {
      const hs = q.filters.find(f => f[1] === 'email_hash')?.[2] || []
      return { data: hs.filter(h => blocked.has(h)).map(h => ({ email_hash: h, reason: 'admin', created_at: TS })), error: null }
    }
    if (q.op === 'rpc' && q.name === 'verified_candidate_counts') return { data: [{ role_category: 'sales', candidate_count: 3 }], error: null }
    return undefined
  })
  const mailed = []
  const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'services/email.service.js': { sendOwnerNotice: async () => {}, sendOwnerAlert: async () => {},
      sendEmployerCandidatesAvailable: async (env, sb, to, n, f, cnt, links) => { const r = mailResult ? mailResult(to, links) : true; if (r) mailed.push(to); return r } },
  })
  return { mod, restore, mailed }
}

describe('B1 — a same-inbox duplicate behind the per-mailbox cap is stamped, not failed forever', () => {
  const recent = () => new Date(Date.now() - 5 * 864e5).toISOString()
  const setup = (logs) => {
    const leads = [mk(uid(1), 'dana@x.com', { candidates_notified_fields: { sales: recent() } }), mk(uid(2), 'dana+jobs@x.com')]
    const e = notifyEnv({ leads, logs, mailResult: (to, links) => { links.outcome.status = 'throttled'; return false } })
    return { leads, ...e }
  }
  it('adopts the send time the log holds under the OTHER spelling', async () => {
    const sentAt = recent()
    const { leads, mod, restore } = setup([{ to: 'dana@x.com', sent_at: sentAt }])
    const r1 = await mod.adminNotifyCandidates(ctx({ field: 'sales' }))
    restore()
    expect(r1.b.data).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
    expect(leads[1].candidates_notified_fields.sales).toBe(sentAt)
  })
  it('still stamps when the throttle is the only evidence (log row gone), so the next run is clean', async () => {
    const { leads, mod, restore } = setup([])
    const r1 = await mod.adminNotifyCandidates(ctx({ field: 'sales' }))
    expect(r1.b.data).toMatchObject({ failed: 0, skipped: 1 })
    expect(leads[1].candidates_notified_fields.sales).toBeTruthy()
    const r2 = await mod.adminNotifyCandidates(ctx({ field: 'sales' }))
    restore()
    expect(r2.b.data).toMatchObject({ eligible: 0, failed: 0, skipped: 0 })
  })
  it('a plain provider failure (not throttled, no log) is still a failure to retry', async () => {
    const leads = [mk(uid(3), 'solo@x.com')]
    const { mod, restore } = notifyEnv({ leads, mailResult: (to, links) => { links.outcome.status = 'failed'; return false } })
    const r = await mod.adminNotifyCandidates(ctx({ field: 'sales' }))
    restore()
    expect(r.b.data).toMatchObject({ failed: 1, skipped: 0 })
    expect(leads[0].candidates_notified_fields.sales).toBeUndefined()
  })
})

describe('B4 — the notify scan steps past 100 leads that share one created_at', () => {
  const build = async () => {
    const leads = Array.from({ length: 150 }, (_, i) => mk(uid(i + 1), `p${String(i + 1).padStart(3, '0')}@acme${i}.com`))
    const blocked = new Set(await Promise.all(leads.slice(0, 100).map(l => sha256(l.email))))
    return { leads, blocked }
  }
  it('reaches the sendable leads behind a full tied window of blocked ones', async () => {
    const { leads, blocked } = await build()
    const { mod, restore, mailed } = notifyEnv({ leads, blocked })
    const r = await mod.adminNotifyCandidates(ctx({ field: 'sales' }))
    restore()
    expect(r.b.data).toMatchObject({ sent: 25, skipped: 100 })
    expect(mailed).toHaveLength(25)
    expect(mailed.every(e => Number(/p(\d+)@/.exec(e)[1]) > 100)).toBe(true)
  })
  it('a dry run counts the blocked ones beyond the first 100 too', async () => {
    const { leads, blocked } = await build()
    blocked.add(await sha256(leads[120].email))
    const { mod, restore } = notifyEnv({ leads, blocked })
    const r = await mod.adminNotifyCandidates(ctx({ field: 'sales', dryRun: true }))
    restore()
    expect(r.b.data.eligible).toBe(49)
  })
})

describe('B2 — merge keeps the furthest-along status', () => {
  async function merge(keepStatus, otherStatus) {
    const rows = [mk(uid(10), 'dana@x.com', { status: keepStatus, contacted_at: keepStatus === 'NEW' ? null : TS }),
                  mk(uid(11), 'dana+j@x.com', { status: otherStatus, contacted_at: TS })]
    let patch = null
    const db = createFakeSupabase(q => {
      if (q.table === 'employer_leads' && q.op === 'select') return { data: rows, error: null }
      if (q.table === 'employer_leads' && q.op === 'update') { patch = q.patch; return { data: { id: uid(10) }, error: null } }
      return undefined
    })
    const { mod, restore } = loadWithStubs('controllers/employer-leads.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': {} })
    const res = await mod.adminMergeLeads(ctx({ keepId: uid(10), mergeIds: [uid(11)] }))
    restore()
    return { res, patch }
  }
  it('CONVERTED duplicate into a CONTACTED keep → CONVERTED', async () => { expect((await merge('CONTACTED', 'CONVERTED')).patch.status).toBe('CONVERTED') })
  it('NEW keep still takes the best other (unchanged behaviour)', async () => { expect((await merge('NEW', 'CONTACTED')).patch.status).toBe('CONTACTED') })
  it('a lower-ranked duplicate never demotes the keep', async () => { expect((await merge('CONVERTED', 'NEW')).patch.status).toBeUndefined() })
  it('an active duplicate is not archived by an ARCHIVED keep, and the archive flag is cleared', async () => {
    const { patch } = await merge('ARCHIVED', 'CONTACTED')
    expect(patch).toMatchObject({ status: 'CONTACTED', archived_resubmitted_at: null })
  })
  it('all-archived stays archived', async () => { expect((await merge('ARCHIVED', 'ARCHIVED')).patch.status).toBeUndefined() })
})

describe('B3 — overriding a removal needs the same step-up as lifting it', () => {
  const src = readFileSync(new URL('../src/routes/employer-leads.routes.js', import.meta.url), 'utf8')
  it('POST /manual and PATCH /:id are behind stepUpWhen(overridesRemoval)', () => {
    expect(src).toMatch(/router\.post\('\/manual', admin, admin\.stepUpWhen\(overridesRemoval\),/)
    expect(src).toMatch(/router\.patch\( '\/:id', admin, admin\.stepUpWhen\(overridesRemoval\),/)
  })
  it('the predicate fires only for an explicit overrideRemoval: true', () => {
    const fn = /const overridesRemoval = (.+)/.exec(src)[1]
    const f = new Function(`return ${fn}`)()
    expect(f({ overrideRemoval: true })).toBe(true)
    expect(f({ overrideRemoval: false })).toBe(false)
    expect(f({ email: 'a@b.co' })).toBe(false)
    expect(f(null)).toBe(false)
  })
})
