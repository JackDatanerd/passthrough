import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase, eqValue } from './helpers/fakeSupabase.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

const lib = require('../src/lib/outcomes')
const constants = require('../src/config/constants')

const SCAN = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const GOOD_STORY = { consent: true, displayName: 'Amara O.', quote: 'Forty applications, zero replies — then this.', text: 'I applied for two months with no replies at all. After the fix I heard back from the very first role.', showCredential: true }

describe('lib/outcomes — parseSubmit', () => {
  it('accepts a bare answer and keeps story undefined (= leave any story alone)', () => {
    const r = lib.parseSubmit({ scanId: SCAN, outcome: 'NO_INTERVIEW' })
    expect(r.ok).toBe(true)
    expect(r.data.story).toBeUndefined()
  })
  it('rejects a story without consent, with the reason the person can act on', () => {
    const r = lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', story: { ...GOOD_STORY, consent: false } })
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toMatch(/tick the box/i)
  })
  it('rejects links, addresses and phone numbers in any story field', () => {
    for (const bad of [
      { text: 'Visit https://pay.example/win to see how I did it, it really worked for me.' },
      { text: 'Email me at amara@example.com and I will tell you everything about it ok.' },
      { quote: 'Call 0712 345 678 for the secret to getting hired' },
      { displayName: 'win.example' },
    ]) expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', story: { ...GOOD_STORY, ...bad } }).ok, JSON.stringify(bad)).toBe(false)
  })
  it('refuses interview details, or a story, on an answer that is not an interview', () => {
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'NO_INTERVIEW', interviewCount: 2 }).ok).toBe(false)
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'STILL_APPLYING', story: GOOD_STORY }).ok).toBe(false)
  })
  it('bounds the interview count and days', () => {
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 0 }).ok).toBe(false)
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2.5 }).ok).toBe(false)
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', interviewAfterDays: 366 }).ok).toBe(false)
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 3, interviewAfterDays: 0 }).ok).toBe(true)
  })
  it('treats null/garbage bodies as a missing scanId, not a crash', () => {
    expect(lib.parseSubmit(null).ok).toBe(false)
    expect(lib.parseSubmit('x').ok).toBe(false)
    expect(lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', story: 'hello' }).ok).toBe(false)
  })
})

describe('lib/outcomes — nextStoryState', () => {
  const parsed = lib.parseSubmit({ scanId: SCAN, outcome: 'INTERVIEW', story: GOOD_STORY }).data.story
  const approved = { story_status: 'APPROVED', story_display_name: parsed.displayName, story_quote: parsed.quote, story_text: parsed.text, story_show_credential: true }
  it('a first submission is PENDING', () => {
    expect(lib.nextStoryState(null, parsed).story_status).toBe('PENDING')
  })
  it('resubmitting identical content keeps the review state (an approved story stays approved)', () => {
    expect(lib.nextStoryState(approved, parsed).story_status).toBe('APPROVED')
  })
  it('ANY change to what readers see sends an approved story back to review', () => {
    for (const patch of [{ text: parsed.text + ' Plus one more sentence.' }, { quote: 'A different headline for this.' }, { displayName: 'Amara' }, { showCredential: false }])
      expect(lib.nextStoryState(approved, { ...parsed, ...patch }), JSON.stringify(patch)).toMatchObject({ story_status: 'PENDING', story_moderated_at: null })
  })
  it('null withdraws it entirely', () => {
    expect(lib.nextStoryState(approved, null)).toMatchObject({ story_status: 'NONE', story_consent: false, story_text: null, story_quote: null, story_display_name: null, story_show_credential: false })
  })
})

describe('lib/outcomes — public numbers', () => {
  it('withholds the interview rate below the minimum response count', () => {
    expect(lib.interviewRatePct(constants.OUTCOME_MIN_RESPONSES - 1, 40)).toBeNull()
    expect(lib.interviewRatePct(constants.OUTCOME_MIN_RESPONSES, 33)).toBe(66)
  })
  it('never returns an impossible rate', () => {
    expect(lib.interviewRatePct(100, 101)).toBeNull()
    expect(lib.interviewRatePct('x', 1)).toBeNull()
  })
  it('only shows a change against a base worth comparing to', () => {
    expect(lib.changePct(4, 3)).toBeNull()
    expect(lib.changePct(12, 10)).toBe(20)
    expect(lib.changePct(8, 10)).toBe(-20)
  })
})

describe('lib/outcomes — toPublicStory', () => {
  const row = (over = {}, scan = {}) => ({
    story_status: 'APPROVED', outcome: 'INTERVIEW', role_category: 'marketing', interview_count: 2, interview_after_days: 6,
    story_display_name: 'Priya S.', story_quote: 'Two calls booked by Friday.', story_text: 'I was laid off on a Monday and had two calls by the next Friday.', story_show_credential: true,
    scans: { ats_score: 41, fix_ats_score: 84, verification_code: 'K7M2QX9P4A', verification_status: 'ACTIVE', verification_revoked_at: null, ...scan }, ...over,
  })
  it('only ever publishes an APPROVED interview story', () => {
    expect(lib.toPublicStory(row({ story_status: 'PENDING' }), 'x')).toBeNull()
    expect(lib.toPublicStory(row({ story_status: 'REJECTED' }), 'x')).toBeNull()
    expect(lib.toPublicStory(row({ outcome: 'NO_INTERVIEW' }), 'x')).toBeNull()
  })
  it('links the credential only while it is live and the author asked for it', () => {
    expect(lib.toPublicStory(row(), 'x').credentialCode).toBe('K7M2QX9P4A')
    expect(lib.toPublicStory(row({}, { verification_status: 'REVOKED' }), 'x').credentialCode).toBeNull()
    expect(lib.toPublicStory(row({}, { verification_revoked_at: '2026-10-01T00:00:00Z' }), 'x').credentialCode).toBeNull()
    expect(lib.toPublicStory(row({ story_show_credential: false }), 'x').credentialCode).toBeNull()
    expect(lib.toPublicStory(row({}, { verification_code: null }), 'x').credentialCode).toBeNull()
  })
  it('re-vets on the way out: a stored name that would fail today is dropped, not shown', () => {
    expect(lib.toPublicStory(row({ story_display_name: 'https://evil.example' }), 'x')).toBeNull()
  })
  it('never carries the scan id, user id or any contact field', () => {
    const out = lib.toPublicStory(row({ scan_id: SCAN, user_id: USER }), 'abc')
    expect(JSON.stringify(out)).not.toContain(SCAN)
    expect(JSON.stringify(out)).not.toContain(USER)
    expect(Object.keys(out).sort()).toEqual(['credentialCode', 'displayName', 'id', 'interviewAfterDays', 'interviewCount', 'quote', 'roleCategory', 'scoreAfter', 'scoreBefore', 'story'])
  })
})

// ── controller ──────────────────────────────────────────────────────────────────────────────────
let restore
afterEach(() => { restore?.(); restore = undefined })

function ctxFor({ body, user = { id: USER }, params = {}, query = {}, env = {} } = {}) {
  const headers = {}
  return {
    env, headers,
    get: k => (k === 'user' ? user : undefined),
    header: (k, v) => { headers[k] = v },
    req: { json: async () => { if (body === undefined) throw new Error('no body'); return body }, param: k => params[k], query: k => query[k] },
    json: (b, status = 200) => ({ body: b, status }),
  }
}
function outcomesSetup(resolver, emailStub = { sendOutcomeFollowUp: async () => true }) {
  const db = createFakeSupabase(resolver)
  const loaded = loadWithStubs('controllers/outcomes.controller.js', { 'config/supabase.js': { getSupabase: () => db }, 'services/email.service.js': emailStub })
  restore = loaded.restore
  return { c: loaded.mod, db }
}
const deliveredScan = (over = {}) => ({ id: SCAN, user_id: USER, role_category: 'marketing', fix_purchased: true, fix_generated_at: '2026-09-01T00:00:00Z', ...over })

describe('submitOutcome', () => {
  it('400s a malformed body before touching the database', async () => {
    const { c, db } = outcomesSetup(() => undefined)
    const res = await c.submitOutcome(ctxFor({ body: { scanId: 'nope', outcome: 'INTERVIEW' } }))
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
  it("404s someone else's scan exactly like a missing one", async () => {
    const { c } = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan({ user_id: 'someone-else' }), error: null } : undefined))
    const mine = await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))
    const { c: c2 } = outcomesSetup(q => (q.table === 'scans' ? { data: null, error: null } : undefined))
    const missing = await c2.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))
    expect(mine).toEqual(missing)
    expect(mine.status).toBe(404)
  })
  it('409s a fix that was paid for but not delivered yet', async () => {
    const { c } = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan({ fix_generated_at: null }), error: null } : undefined))
    expect((await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))).status).toBe(409)
  })
  it('409s a scan with no purchased fix (a free scan has nothing to report on)', async () => {
    const { c } = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan({ fix_purchased: false }), error: null } : undefined))
    expect((await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))).status).toBe(409)
  })
  it('stores the answer with the scan\'s own role category, never one the client sent', async () => {
    const { c, db } = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan(), error: null } : undefined))
    const res = await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 6, roleCategory: 'sales', userId: 'evil' } }))
    expect(res.status).toBe(200)
    const up = db.calls.find(q => q.op === 'upsert')
    expect(up.values).toMatchObject({ scan_id: SCAN, user_id: USER, role_category: 'marketing', outcome: 'INTERVIEW', interview_count: 2, interview_after_days: 6 })
    expect(up.values.answered_at).toBeTruthy()
    expect(up.values).not.toHaveProperty('story_status')   // no story field sent: nothing touched
  })
  it('a changed answer keeps the original answered_at', async () => {
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans') return { data: deliveredScan(), error: null }
      if (q.table === 'scan_outcomes' && q.op === 'select') return { data: { story_status: 'NONE' }, error: null }
    })
    await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'NO_INTERVIEW' } }))
    expect(db.calls.find(q => q.op === 'upsert').values).not.toHaveProperty('answered_at')
  })
  it('a new story goes in PENDING — never straight to public', async () => {
    const { c, db } = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan(), error: null } : undefined))
    const res = await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW', story: GOOD_STORY } }))
    expect(res.body.data.storyStatus).toBe('PENDING')
    expect(db.calls.find(q => q.op === 'upsert').values).toMatchObject({ story_status: 'PENDING', story_consent: true, story_show_credential: true })
  })
  it('changing the answer away from "interview" takes an existing story down with it', async () => {
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans') return { data: deliveredScan(), error: null }
      if (q.table === 'scan_outcomes' && q.op === 'select') return { data: { story_status: 'APPROVED', story_text: 'x' }, error: null }
    })
    const res = await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'NO_INTERVIEW' } }))
    expect(db.calls.find(q => q.op === 'upsert').values).toMatchObject({ story_status: 'NONE', story_consent: false, story_text: null })
    expect(res.body.data.storyStatus).toBe('NONE')
  })
  it('surfaces a database error instead of swallowing it', async () => {
    const { c } = outcomesSetup(q => {
      if (q.table === 'scans') return { data: deliveredScan(), error: null }
      if (q.op === 'upsert') return { data: null, error: new Error('boom') }
    })
    await expect(c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))).rejects.toThrow('boom')
  })
})

describe('withdrawStory', () => {
  it('only touches the caller\'s own row, and only one that has a story', async () => {
    const { c, db } = outcomesSetup(q => (q.op === 'update' ? { data: [{ scan_id: SCAN }], error: null } : undefined))
    const res = await c.withdrawStory(ctxFor({ params: { scanId: SCAN } }))
    expect(res.status).toBe(200)
    const q = db.calls.find(x => x.op === 'update')
    expect(eqValue(q, 'scan_id')).toBe(SCAN)
    expect(eqValue(q, 'user_id')).toBe(USER)
    expect(q.patch).toMatchObject({ story_status: 'NONE', story_text: null, story_consent: false })
  })
  it('404s when there is nothing to withdraw', async () => {
    const { c } = outcomesSetup(() => ({ data: [], error: null }))
    expect((await c.withdrawStory(ctxFor({ params: { scanId: SCAN } }))).status).toBe(404)
  })
  it('400s a malformed id', async () => {
    const { c, db } = outcomesSetup(() => undefined)
    expect((await c.withdrawStory(ctxFor({ params: { scanId: 'x' } }))).status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe('pendingOutcomes', () => {
  it('asks only about delivered fixes old enough, and leaves out the ones already answered', async () => {
    const scans = [1, 2, 3, 4, 5].map(i => ({ id: `s${i}`, job_title: `Job ${i}`, role_category: 'sales', ats_score: 40, fix_ats_score: 85, fix_generated_at: '2026-08-01T00:00:00Z' }))
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans') return { data: scans, error: null }
      if (q.table === 'scan_outcomes' && q.filters.some(f => f[0] === 'in')) return { data: [{ scan_id: 's1' }], error: null }
      if (q.table === 'scan_outcomes') return { data: [{ scan_id: 'sx', story_status: 'PENDING', story_display_name: 'Amara O.', story_quote: 'q', answered_at: '2026-09-02T00:00:00Z' }], error: null }
    })
    const res = await c.pendingOutcomes(ctxFor())
    expect(res.body.data.pending.map(p => p.scanId)).toEqual(['s2', 's3', 's4'])   // capped at 3, s1 answered
    expect(res.body.data.stories[0]).toMatchObject({ scanId: 'sx', status: 'PENDING' })
    const q = db.calls.find(x => x.table === 'scans')
    expect(eqValue(q, 'user_id')).toBe(USER)
    expect(eqValue(q, 'fix_purchased')).toBe(true)
    expect(q.filters.some(f => f[0] === 'lte' && f[1] === 'fix_generated_at')).toBe(true)
  })
})

describe('sweepOutcomePrompts', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z')
  const user = (over = {}) => ({ email: 'a@x.y', name: 'Ann', status: 'ACTIVE', email_verified: true, deleted_at: null, notify_scan_results: true, ...over })
  const row = (id, uid, over = {}) => ({ id, user_id: uid, outcome_prompt_attempts: 0, users: user(over) })
  function run(rows, { answered = [], sent = true, claimResult = [{ id: 'x' }] } = {}) {
    const sends = []
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: rows, error: null }
      if (q.table === 'scan_outcomes') return { data: answered.map(scan_id => ({ scan_id })), error: null }
      if (q.table === 'scans' && q.op === 'update' && q.patch.outcome_prompted_at) return { data: claimResult, error: null }
    }, { sendOutcomeFollowUp: async (...a) => { sends.push(a); return sent } })
    return c.sweepOutcomePrompts({ FRONTEND_URL: 'https://x' }, db, NOW).then(r => ({ r, sends, db }))
  }
  it('looks only at delivered fixes in the 30-to-120-day window that were never prompted', async () => {
    const { db } = await run([])
    const q = db.calls[0]
    expect(q.filters).toContainEqual(['lte', 'fix_generated_at', new Date(NOW - 30 * 86400000).toISOString()])
    expect(q.filters).toContainEqual(['gte', 'fix_generated_at', new Date(NOW - 120 * 86400000).toISOString()])
    expect(q.filters).toContainEqual(['is', 'outcome_prompted_at', null])
    expect(q.filters).toContainEqual(['lt', 'outcome_prompt_attempts', constants.OUTCOME_EMAIL_MAX_ATTEMPTS])
  })
  it('sends one email per person even when several of their fixes qualify', async () => {
    const { r, sends } = await run([row('a', 'u1'), row('b', 'u1'), row('c', 'u2')])
    expect(r.sent).toBe(2)
    expect(sends).toHaveLength(2)
  })
  it('skips people who answered, opted out, are banned, deleted or unverified', async () => {
    const { r, sends } = await run([
      row('a', 'u1'), row('b', 'u2', { notify_scan_results: false }), row('c', 'u3', { status: 'BANNED' }),
      row('d', 'u4', { deleted_at: '2026-09-01T00:00:00Z' }), row('e', 'u5', { email_verified: false }), row('f', 'u6'),
    ], { answered: ['a'] })
    expect(sends).toHaveLength(1)
    expect(sends[0][3]).toBe('Ann')
    expect(r).toMatchObject({ sent: 1, skipped: 4 })
  })
  it('does not send when another run has already claimed the scan', async () => {
    const { r, sends } = await run([row('a', 'u1')], { claimResult: [] })
    expect(sends).toHaveLength(0)
    expect(r.sent).toBe(0)
  })
  it('releases the claim when the send did not go, so the next run retries (bounded by attempts)', async () => {
    const { r, db } = await run([row('a', 'u1')], { sent: false })
    expect(r.failed).toBe(1)
    const release = db.calls.filter(q => q.op === 'update').pop()
    expect(release.patch).toEqual({ outcome_prompted_at: null })
    const claim = db.calls.find(q => q.op === 'update' && q.patch.outcome_prompted_at)
    expect(claim.patch.outcome_prompt_attempts).toBe(1)
  })
  it('never lets a throwing sender escape', async () => {
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans' && q.op === 'select') return { data: [row('a', 'u1')], error: null }
      if (q.table === 'scans' && q.op === 'update' && q.patch.outcome_prompted_at) return { data: [{ id: 'a' }], error: null }
    }, { sendOutcomeFollowUp: async () => { throw new Error('resend down') } })
    const r = await c.sweepOutcomePrompts({}, db, NOW)
    expect(r.failed).toBe(1)
  })
  it('reports a query failure instead of throwing', async () => {
    const { c, db } = outcomesSetup(() => ({ data: null, error: { message: 'db down' } }))
    expect((await c.sweepOutcomePrompts({}, db, NOW)).error).toBe('db down')
  })
})

// ── public stats ────────────────────────────────────────────────────────────────────────────────
function statsSetup(over = {}) {
  const rows = over.rows ?? [{ resumes_scanned: 25123, responses: 120, interviews: 79, first_answer_at: '2026-08-01T00:00:00Z' }]
  const db = createFakeSupabase(q => {
    if (q.op === 'rpc' && q.name === 'public_home_stats') return over.stats ?? { data: rows, error: null }
    if (q.op === 'rpc' && q.name === 'public_hot_categories') return over.hot ?? { data: q.args.p_days === 7 ? [{ role_category: 'software_engineering', interviews: 41, prev_interviews: 30 }, { role_category: 'legal', interviews: 12, prev_interviews: 2 }] : [], error: null }
    if (q.table === 'scan_outcomes') return over.stories ?? { data: [], error: null }
  })
  const loaded = loadWithStubs('controllers/stats.controller.js', { 'config/supabase.js': { getSupabase: () => db } })
  restore = loaded.restore
  return { c: loaded.mod, db }
}

describe('GET /api/stats', () => {
  it('returns totals, hot fields and stories, edge-cacheable when everything answered', async () => {
    const { c } = statsSetup()
    const ctx = ctxFor()
    const res = await c.getHomeStats(ctx)
    expect(res.body.data.stats).toMatchObject({ resumesScanned: 25123, responses: 120, interviewRatePct: 66, minResponses: 50 })
    expect(res.body.data.hotCategories['7'][0]).toEqual({ category: 'software_engineering', interviews: 41, changePct: 37 })
    expect(res.body.data.hotCategories['7'][1].changePct).toBeNull()   // base of 2 is too small to quote a percentage
    expect(res.body.data.hotCategories.minReports).toBe(constants.HOT_CATEGORY_MIN_REPORTS)
    expect(ctx.headers['Cache-Control']).toMatch(/s-maxage=300/)
  })
  it('withholds the rate (but still reports the scan count) below the minimum response count', async () => {
    const { c } = statsSetup({ rows: [{ resumes_scanned: 900, responses: 12, interviews: 12, first_answer_at: '2026-10-01T00:00:00Z' }] })
    const res = await c.getHomeStats(ctxFor())
    expect(res.body.data.stats.interviewRatePct).toBeNull()
    expect(res.body.data.stats.since).toBeNull()
    expect(res.body.data.stats.resumesScanned).toBe(900)
  })
  it('asks the database for the 7- and 30-day windows with the minimum-report floor', async () => {
    const { c, db } = statsSetup()
    await c.getHomeStats(ctxFor())
    const hot = db.calls.filter(q => q.name === 'public_hot_categories').map(q => q.args)
    expect(hot).toContainEqual({ p_days: 7, p_min: constants.HOT_CATEGORY_MIN_REPORTS })
    expect(hot).toContainEqual({ p_days: 30, p_min: constants.HOT_CATEGORY_MIN_REPORTS })
  })
  it('asks only for APPROVED interview stories, newest decision first', async () => {
    const { c, db } = statsSetup()
    await c.getHomeStats(ctxFor())
    const q = db.calls.find(x => x.table === 'scan_outcomes')
    expect(eqValue(q, 'story_status')).toBe('APPROVED')
    expect(eqValue(q, 'outcome')).toBe('INTERVIEW')
  })
  it('degrades one failing block to null/[] instead of failing the page — and refuses to cache the degraded answer', async () => {
    const { c } = statsSetup({ stats: { data: null, error: { message: 'rpc down' } } })
    const ctx = ctxFor()
    const res = await c.getHomeStats(ctx)
    expect(res.status).toBe(200)
    expect(res.body.data.stats.resumesScanned).toBeNull()
    expect(res.body.data.stats.interviewRatePct).toBeNull()
    expect(res.body.data.hotCategories['7']).toHaveLength(2)   // the other blocks still came through
    expect(ctx.headers['Cache-Control']).toBe('no-store')
  })
  it('returns at most HOMEPAGE_STORIES stories and drops any that fail the public vetting', async () => {
    const mk = (i, over = {}) => ({ scan_id: `00000000-0000-4000-8000-00000000000${i}`, role_category: 'sales', outcome: 'INTERVIEW', story_status: 'APPROVED', story_display_name: `Name${i} K.`, story_quote: 'A decent headline here.', story_text: 'A long enough story about how this went for me and what happened next.', story_show_credential: false, scans: { ats_score: 40, fix_ats_score: 85 }, ...over })
    const { c } = statsSetup({ stories: { data: [mk(1, { story_display_name: 'https://bad.example' }), mk(2), mk(3), mk(4), mk(5)], error: null } })
    const res = await c.getHomeStats(ctxFor())
    expect(res.body.data.stories).toHaveLength(constants.HOMEPAGE_STORIES)
    expect(res.body.data.stories.map(s => s.displayName)).toEqual(['Name2 K.', 'Name3 K.', 'Name4 K.'])
    expect(new Set(res.body.data.stories.map(s => s.id)).size).toBe(3)
    expect(JSON.stringify(res.body)).not.toContain('00000000-0000-4000')
  })
})

// ── admin moderation ────────────────────────────────────────────────────────────────────────────
function adminSetup(resolver) {
  const db = createFakeSupabase(resolver)
  const audit = []
  const loaded = loadWithStubs('controllers/admin-stories.controller.js', {
    'config/supabase.js': { getSupabase: () => db },
    'lib/adminAudit.js': { logAdminAction: async (...a) => { audit.push(a.slice(2)) } },
  })
  restore = loaded.restore
  return { c: loaded.mod, db, audit }
}
const storyRow = (over = {}) => ({ scan_id: SCAN, outcome: 'INTERVIEW', story_status: 'PENDING', story_text: 'x'.repeat(60), story_quote: 'A headline here ok.', story_display_name: 'Amara O.', ...over })

describe('admin story moderation', () => {
  const actor = { id: 'admin-1' }
  it('approves a pending story, stamps who/when, and audit-logs ids only', async () => {
    const { c, db, audit } = adminSetup(q => {
      if (q.op === 'select') return { data: storyRow(), error: null }
      if (q.op === 'update') return { data: [{ scan_id: SCAN }], error: null }
    })
    const res = await c.adminModerateStory(ctxFor({ user: actor, params: { id: SCAN }, body: { action: 'approve' } }))
    expect(res.body.data).toEqual({ changed: true, status: 'APPROVED' })
    const up = db.calls.find(q => q.op === 'update')
    expect(up.patch).toMatchObject({ story_status: 'APPROVED', story_moderated_by: 'admin-1' })
    expect(audit[0]).toEqual(['story.approve', 'scan', SCAN, { from: 'PENDING', to: 'APPROVED' }])
    expect(JSON.stringify(audit)).not.toContain('Amara')
  })
  it('guards the write on the exact text it read: an author edit mid-review is a 409, not an approval of unseen words', async () => {
    const { c, db } = adminSetup(q => {
      if (q.op === 'select') return { data: storyRow(), error: null }
      if (q.op === 'update') return { data: [], error: null }
    })
    const res = await c.adminModerateStory(ctxFor({ user: actor, params: { id: SCAN }, body: { action: 'approve' } }))
    expect(res.status).toBe(409)
    const up = db.calls.find(q => q.op === 'update')
    expect(up.filters).toContainEqual(['eq', 'story_text', 'x'.repeat(60)])
    expect(up.filters).toContainEqual(['eq', 'story_status', 'PENDING'])
  })
  it('can take an approved story down', async () => {
    const { c, audit } = adminSetup(q => {
      if (q.op === 'select') return { data: storyRow({ story_status: 'APPROVED' }), error: null }
      if (q.op === 'update') return { data: [{ scan_id: SCAN }], error: null }
    })
    const res = await c.adminModerateStory(ctxFor({ user: actor, params: { id: SCAN }, body: { action: 'reject' } }))
    expect(res.body.data.status).toBe('REJECTED')
    expect(audit[0][0]).toBe('story.reject')
  })
  it('is a no-op (and not audited) when the story is already in that state', async () => {
    const { c, db, audit } = adminSetup(q => (q.op === 'select' ? { data: storyRow({ story_status: 'APPROVED' }), error: null } : undefined))
    const res = await c.adminModerateStory(ctxFor({ user: actor, params: { id: SCAN }, body: { action: 'approve' } }))
    expect(res.body.data.changed).toBe(false)
    expect(db.calls.some(q => q.op === 'update')).toBe(false)
    expect(audit).toHaveLength(0)
  })
  it('404s a scan with no story, 400s an unknown action, 409s an incomplete story', async () => {
    let s = adminSetup(q => (q.op === 'select' ? { data: storyRow({ story_status: 'NONE' }), error: null } : undefined))
    expect((await s.c.adminModerateStory(ctxFor({ params: { id: SCAN }, body: { action: 'approve' } }))).status).toBe(404)
    restore()
    s = adminSetup(() => undefined)
    expect((await s.c.adminModerateStory(ctxFor({ params: { id: SCAN }, body: { action: 'delete' } }))).status).toBe(400)
    restore()
    s = adminSetup(q => (q.op === 'select' ? { data: storyRow({ story_quote: null }), error: null } : undefined))
    expect((await s.c.adminModerateStory(ctxFor({ params: { id: SCAN }, body: { action: 'approve' } }))).status).toBe(409)
  })
  it('lists PENDING by default and ignores an unknown status filter', async () => {
    const { c, db } = adminSetup(() => ({ data: [], error: null }))
    await c.adminListStories(ctxFor({ query: { status: 'NONE' } }))
    expect(eqValue(db.calls[0], 'story_status')).toBe('PENDING')
  })
})

// ── the migration itself ────────────────────────────────────────────────────────────────────────
describe('migration 0070', () => {
  const dir = path.join(__dirname, '..', 'supabase', 'migrations')
  const sql = fs.readFileSync(path.join(dir, '0070_homepage_outcomes.sql'), 'utf8')
  const strip = s => s.replace(/--.*$/gm, '')
  it('locks the new table down like every other (RLS, no policies) and the new functions to service_role', () => {
    expect(strip(sql)).toMatch(/alter table scan_outcomes enable row level security/)
    expect(strip(sql)).not.toMatch(/create policy/)
    for (const fn of ['public_home_stats()', 'public_hot_categories(int, int)', 'bump_scans_completed_total()'])
      expect(strip(sql)).toContain(`revoke execute on function ${fn}`)
    expect(strip(sql)).toMatch(/grant\s+execute on function public_home_stats\(\)\s+to service_role/)
  })
  it('redefines scrub_account_data without dropping ANY column the previous definition cleared', () => {
    const earlier = fs.readdirSync(dir).filter(f => f < '0070_' && /^\d{4}_.*\.sql$/.test(f)).sort().reverse()
      .find(f => /create or replace function scrub_account_data/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    const prev = strip(fs.readFileSync(path.join(dir, earlier), 'utf8'))
    const fnBody = t => t.slice(t.indexOf('create or replace function scrub_account_data'))
    const assigned = t => new Set([...fnBody(t).matchAll(/^\s+([a-z_]+)\s*=/gm)].map(m => m[1]))
    const before = assigned(prev), after = assigned(strip(sql))
    const dropped = [...before].filter(c => !after.has(c))
    expect(dropped).toEqual([])
    expect([...after]).toEqual(expect.arrayContaining(['story_text', 'story_quote', 'story_display_name', 'story_status']))
  })
  it('keeps the published rate meaningful after account deletion: the scrub clears the story, not the answer', () => {
    const scrub = strip(sql).slice(strip(sql).indexOf('update scan_outcomes set'))
    expect(scrub.slice(0, scrub.indexOf(';'))).not.toMatch(/\boutcome\s*=/)
  })
  it('refuses a story without consent and interview details without an interview (database-level)', () => {
    expect(strip(sql)).toMatch(/story_status = 'NONE' or story_consent/)
    expect(strip(sql)).toMatch(/outcome = 'INTERVIEW' or \(interview_count is null and interview_after_days is null\)/)
  })
  it('ends by recording its own number, matching the code', () => {
    expect(sql.trim().split('\n').slice(-3).join('\n')).toMatch(/'version', 70/)
    // `>=`, not `toBe(70)`: every later migration bumps the expected version, and the "newest migration and the
    // constant agree" guard already lives in crossCutting.round1.test.js. Pinning 70 here broke on migration 0071.
    expect(constants.EXPECTED_SCHEMA_VERSION).toBeGreaterThanOrEqual(70)
  })
})
