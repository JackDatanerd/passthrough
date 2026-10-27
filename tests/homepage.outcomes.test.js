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
  it('never shows the story of a refunded or disputed purchase', () => {
    expect(lib.toPublicStory(row({ scans: { verification_code: 'ABC', verification_status: 'REVOKED', verification_revoked_at: '2026-09-01', verification_revoked_reason: 'REFUND' } }), 'abc')).toBeNull()
    expect(lib.toPublicStory(row({ scans: { verification_revoked_reason: 'DISPUTE' } }), 'abc')).toBeNull()
    expect(lib.toPublicStory(row({ scans: { verification_revoked_reason: 'OWNER' } }), 'abc')).not.toBeNull()   // the owner hiding their own page is not a reversal
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
  it('an answer that becomes "interview" counts from today (so the hot-fields window sees it); other changes keep the first date', async () => {
    const upserts = []
    const mk = (existing) => outcomesSetup(q => {
      if (q.table === 'scans') return { data: deliveredScan(), error: null }
      if (q.table === 'scan_outcomes' && q.op === 'select') return { data: existing, error: null }
      if (q.table === 'scan_outcomes' && q.op === 'upsert') { upserts.push(q.values); return { data: null, error: null } }
    }).c
    await mk({ outcome: 'NO_INTERVIEW', story_status: 'NONE' }).submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))
    await mk({ outcome: 'STILL_APPLYING', story_status: 'NONE' }).submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'NO_INTERVIEW' } }))
    await mk({ outcome: 'INTERVIEW', story_status: 'NONE' }).submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW', interviewCount: 2 } }))
    await mk(null).submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'NO_INTERVIEW' } }))
    expect(upserts.map(u => 'answered_at' in u)).toEqual([true, false, false, true])
  })
  describe('interview details and a published story', () => {
    const existing = (over = {}) => ({ outcome: 'INTERVIEW', interview_count: 2, interview_after_days: 9, story_status: 'APPROVED', story_display_name: 'Amara O.', story_quote: 'Got three calls in two weeks', story_text: 'My resume finally got past the filters and I had three calls within two weeks.', story_show_credential: false, ...over })
    function run(existingRow, body) {
      const upserts = []
      const { c } = outcomesSetup(q => {
        if (q.table === 'scans') return { data: deliveredScan(), error: null }
        if (q.table === 'scan_outcomes' && q.op === 'select') return { data: existingRow, error: null }
        if (q.table === 'scan_outcomes' && q.op === 'upsert') { upserts.push(q.values); return { data: null, error: null } }
      })
      return c.submitOutcome(ctxFor({ body: { scanId: SCAN, ...body } })).then(res => ({ res, upserts }))
    }
    it('tapping "yes" again keeps the details instead of wiping them', async () => {
      const { res, upserts } = await run(existing({ story_status: 'NONE' }), { outcome: 'INTERVIEW' })
      expect(res.status).toBe(200)
      expect(upserts[0]).toMatchObject({ interview_count: 2, interview_after_days: 9 })
    })
    it('details never follow the person to another answer', async () => {
      const { upserts } = await run(existing({ story_status: 'NONE' }), { outcome: 'NO_INTERVIEW' })
      expect(upserts[0]).toMatchObject({ interview_count: null, interview_after_days: null })
    })
    it('changing the numbers of a published story without the story is refused — it would change what was approved', async () => {
      const { res, upserts } = await run(existing(), { outcome: 'INTERVIEW', interviewCount: 40 })
      expect(res.status).toBe(409)
      expect(upserts).toHaveLength(0)
    })
    it('changing the numbers together with the story sends it back to review, even if its words are unchanged', async () => {
      const { res, upserts } = await run(existing(), { outcome: 'INTERVIEW', interviewCount: 40, interviewAfterDays: 9,
        story: { consent: true, displayName: 'Amara O.', quote: 'Got three calls in two weeks', text: 'My resume finally got past the filters and I had three calls within two weeks.', showCredential: false } })
      expect(res.status).toBe(200)
      expect(upserts[0]).toMatchObject({ interview_count: 40, story_status: 'PENDING', story_moderated_at: null })
    })
    it('the same numbers leave an approved story approved', async () => {
      const { res, upserts } = await run(existing(), { outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 9 })
      expect(res.status).toBe(200)
      expect(upserts[0].story_status).toBeUndefined()
    })
  })
  it('409s a refunded or disputed purchase (and a delivery whose rewrite failed)', async () => {
    const { c } = outcomesSetup(q => {
      if (q.table === 'scans') return { data: deliveredScan({ fix_payment_id: 'p1' }), error: null }
      if (q.table === 'payments') return { data: [{ id: 'p1', status: 'DISPUTED' }], error: null }
    })
    expect((await c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))).status).toBe(409)
    const failed = outcomesSetup(q => (q.table === 'scans' ? { data: deliveredScan({ rewrite_failed: true }), error: null } : undefined))
    expect((await failed.c.submitOutcome(ctxFor({ body: { scanId: SCAN, outcome: 'INTERVIEW' } }))).status).toBe(409)
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
  const NOWISO = '2026-10-10T12:00:00Z'
  const scanRow = (i, over = {}) => ({ id: `s${i}`, user_id: USER, job_title: `Job ${i}`, role_category: 'sales', fix_tier: 'FIX', ats_score: 40, fix_ats_score: 85, fix_purchased: true, fix_payment_id: `p${i}`, rewrite_failed: false, first_delivered_at: '2026-08-01T00:00:00Z', fix_generated_at: '2026-08-01T00:00:00Z', ...over })
  const outRow = (scan_id, over = {}) => ({ scan_id, outcome: 'NO_INTERVIEW', interview_count: null, interview_after_days: null, story_status: 'NONE', story_display_name: null, story_quote: null, answered_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-22T00:00:00Z', scans: { job_title: 'Job', role_category: 'sales', fix_tier: 'FIX', fix_payment_id: 'pp', first_delivered_at: '2026-08-01T00:00:00Z' }, ...over })
  function setup({ scans = [], outs = [], reversed = [] } = {}) {
    return outcomesSetup(q => {
      if (q.table === 'scans') {
        const [from, to] = q.range || [0, 999]
        return { data: scans.slice(from, to + 1), error: null }
      }
      if (q.table === 'scan_outcomes') return { data: outs, error: null }
      if (q.table === 'payments') return { data: reversed.map(id => ({ id, status: 'REFUNDED' })), error: null }
    })
  }
  const run = async (c, fn = {}) => { const realNow = Date.now; Date.now = () => Date.parse(NOWISO); try { return await c.pendingOutcomes(ctxFor()) } finally { Date.now = realNow } }

  it('asks only about delivered fixes old enough, and leaves out the ones already answered', async () => {
    const { c, db } = setup({ scans: [1, 2, 3, 4, 5].map(i => scanRow(i)), outs: [outRow('s1')] })
    const res = await run(c)
    expect(res.body.data.pending.map(p => p.scanId)).toEqual(['s2', 's3', 's4'])   // capped at 3, s1 answered
    const q = db.calls.find(x => x.table === 'scans')
    expect(eqValue(q, 'user_id')).toBe(USER)
    expect(eqValue(q, 'fix_purchased')).toBe(true)
    // time is measured from the FIRST delivery, so an edit or a retry (which rewrite fix_generated_at) never moves it
    // (the age rules live in evaluateAsk now, so a too-early fix can still be offered as "report an interview")
    expect(q.filters).toContainEqual(['not', 'first_delivered_at', 'is', null])
    expect(q.filters.some(f => f[1] === 'fix_generated_at')).toBe(false)
  })
  it('an answered scan never pushes an unanswered one out of view (more than one page of answered scans)', async () => {
    const scans = Array.from({ length: 30 }, (_, i) => scanRow(i + 1))
    const outs = scans.slice(0, 26).map(s => outRow(s.id))
    const { c } = setup({ scans, outs })
    const res = await run(c)
    expect(res.body.data.pending.map(p => p.scanId)).toEqual(['s27', 's28', 's29'])
  })
  it('does not ask about a refunded or disputed purchase, a failed rewrite, or one past the age limit', async () => {
    const { c } = setup({
      scans: [scanRow(1), scanRow(2, { rewrite_failed: true }), scanRow(3, { first_delivered_at: '2026-05-01T00:00:00Z' }), scanRow(4)],
      reversed: ['p1'],
    })
    expect((await run(c)).body.data.pending.map(p => p.scanId)).toEqual(['s4'])
  })
  it('does not ask a fix delivered less than 14 days ago', async () => {
    const { c } = setup({ scans: [scanRow(1, { first_delivered_at: '2026-10-01T00:00:00Z' })] })
    expect((await run(c)).body.data.pending).toEqual([])
  })
  it('asks again about "still applying" 30 days after it was given — and not before', async () => {
    const stale = outRow('s1', { outcome: 'STILL_APPLYING', updated_at: '2026-09-01T00:00:00Z' })
    const fresh = outRow('s2', { outcome: 'STILL_APPLYING', updated_at: '2026-10-01T00:00:00Z' })
    const { c } = setup({ scans: [scanRow(1), scanRow(2)], outs: [stale, fresh] })
    const res = await run(c)
    expect(res.body.data.pending.map(p => [p.scanId, p.reask])).toEqual([['s1', true]])
    // the re-asked one is not also listed as an answer to change; the other is
    expect(res.body.data.answers.map(a => a.scanId)).toEqual(['s2'])
  })
  it('lists the answers a person has given so any can be changed, and says what kind of delivery it was', async () => {
    const { c } = setup({ scans: [], outs: [outRow('s1', { outcome: 'INTERVIEW', interview_count: 2, story_status: 'PENDING', scans: { job_title: 'Nurse', role_category: 'healthcare', fix_tier: 'BADGE', first_delivered_at: '2026-08-01T00:00:00Z' } })] })
    const res = await run(c)
    expect(res.body.data.answers[0]).toMatchObject({ scanId: 's1', outcome: 'INTERVIEW', interviewCount: 2, storyStatus: 'PENDING', fixTier: 'BADGE', jobTitle: 'Nurse' })
  })
  it('asks "not yet" once more after 30 days and says what the first answer was', async () => {
    const stale = outRow('s1', { outcome: 'NO_INTERVIEW', answered_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' })
    const res = await run(setup({ scans: [scanRow(1)], outs: [stale] }).c)
    expect(res.body.data.pending.map(p => [p.scanId, p.reask, p.previous])).toEqual([['s1', true, 'NO_INTERVIEW']])
  })
  it('offers "report an interview" on delivered fixes that are not being asked about: too early, or past the limit — never answered, refunded or failed ones', async () => {
    const { c } = setup({
      scans: [scanRow(1, { first_delivered_at: '2026-10-08T00:00:00Z' }), scanRow(2, { first_delivered_at: '2026-05-01T00:00:00Z' }), scanRow(3, { first_delivered_at: '2026-10-08T00:00:00Z' }),
        scanRow(4, { first_delivered_at: '2026-10-08T00:00:00Z' }), scanRow(5, { first_delivered_at: '2026-10-08T00:00:00Z', rewrite_failed: true }), scanRow(6)],
      outs: [outRow('s3')], reversed: ['p4'],
    })
    const d = (await run(c)).body.data
    expect(d.reportable.map(r => r.scanId)).toEqual(['s1', 's2'])
    expect(d.pending.map(p => p.scanId)).toEqual(['s6'])
  })
  it('marks the answer of a refunded purchase as locked', async () => {
    const { c } = setup({ outs: [outRow('s1', { scans: { job_title: 'J', role_category: 'sales', fix_tier: 'FIX', fix_payment_id: 'pX', first_delivered_at: '2026-08-01T00:00:00Z' } }), outRow('s2')], reversed: ['pX'] })
    const d = (await run(c)).body.data
    expect(d.answers.map(a => [a.scanId, a.locked])).toEqual([['s1', true], ['s2', false]])
  })
  it('still reports stories', async () => {
    const { c } = setup({ outs: [outRow('sx', { outcome: 'INTERVIEW', story_status: 'PENDING', story_display_name: 'Amara O.', story_quote: 'q' })] })
    expect((await run(c)).body.data.stories[0]).toMatchObject({ scanId: 'sx', status: 'PENDING' })
  })
})

describe('evaluateAsk — the one definition of who is asked', () => {
  const DAY = 86400000
  const NOW = Date.parse('2026-10-10T12:00:00Z')
  const daysAgo = n => new Date(NOW - n * DAY).toISOString()
  const scan = (over = {}) => ({ user_id: USER, fix_purchased: true, first_delivered_at: daysAgo(20), fix_generated_at: daysAgo(1), rewrite_failed: false, outcome_prompted_at: null, outcome_prompt_attempts: 0, ...over })
  const user = (over = {}) => ({ email: 'a@x.y', status: 'ACTIVE', email_verified: true, deleted_at: null, notify_outcome_followup: true, ...over })
  const ev = (o, now = NOW) => lib.evaluateAsk({ user: user(), ...o }, now)

  it('dashboard: asked from day 14 to day 120 after the FIRST delivery, however recently it was edited', () => {
    expect(ev({ scan: scan() }).dashboard).toMatchObject({ ask: true })                                    // 20 days; fix_generated_at is 1 day ago
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(13) }) }).dashboard).toMatchObject({ ask: false, reason: 'TOO_EARLY' })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(14) }) }).dashboard.ask).toBe(true)
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(120) }) }).dashboard.ask).toBe(true)
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(121) }) }).dashboard).toMatchObject({ ask: false, reason: 'TOO_OLD' })
  })
  it('says when a too-early scan will be asked', () => {
    const v = ev({ scan: scan({ first_delivered_at: daysAgo(10) }) }).dashboard
    expect(v.at).toBe(new Date(NOW + 4 * DAY).toISOString())
  })
  it('has no fallback: a missing first-delivery stamp means "not delivered" (a failed rewrite or an upgrade in progress)', () => {
    expect(ev({ scan: scan({ first_delivered_at: null, fix_generated_at: daysAgo(20) }) }).dashboard).toMatchObject({ ask: false, reason: 'NOT_DELIVERED' })
    expect(ev({ scan: scan({ first_delivered_at: null, fix_generated_at: daysAgo(20), rewrite_failed: true }) }).dashboard.reason).toBe('REWRITE_FAILED')
  })
  it('"not yet" is asked once more 30 days after it was given — and only if it was never revisited, and within 120 days of delivery', () => {
    const first = (over = {}) => ({ outcome: 'NO_INTERVIEW', answered_at: daysAgo(31), updated_at: daysAgo(31), ...over })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(60) }), outcome: first() }).dashboard).toMatchObject({ ask: true, reason: 'REASK_NOT_YET' })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(60) }), outcome: first({ answered_at: daysAgo(10), updated_at: daysAgo(10) }) }).dashboard)
      .toMatchObject({ ask: false, reason: 'REASK_NOT_DUE', at: new Date(NOW + 20 * DAY).toISOString() })
    // already revisited (answered again later): final
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(90) }), outcome: first({ updated_at: daysAgo(1) }) }).dashboard.reason).toBe('ANSWERED')
    // past the age limit
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(125) }), outcome: first() }).dashboard.reason).toBe('TOO_OLD')
    // an answer row with no timestamps is final, never a guess
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(60) }), outcome: { outcome: 'NO_INTERVIEW' } }).dashboard.reason).toBe('ANSWERED')
  })
  it('not purchased / not delivered / failed rewrite / refunded: never asked, either way', () => {
    for (const [over, reason, extra] of [[{ fix_purchased: false }, 'NOT_PURCHASED'], [{ first_delivered_at: null, fix_generated_at: null }, 'NOT_DELIVERED'], [{ rewrite_failed: true }, 'REWRITE_FAILED'], [{}, 'PURCHASE_REVERSED', { purchaseLive: false }]]) {
      const v = ev({ scan: scan({ first_delivered_at: daysAgo(40), ...over }), ...(extra || {}) })
      expect(v.dashboard, reason).toMatchObject({ ask: false, reason })
      expect(v.email, reason).toMatchObject({ ask: false, reason })
    }
  })
  it('any answer but "still applying" is final for the dashboard; "still applying" is asked again after 30 days', () => {
    expect(ev({ scan: scan(), outcome: { outcome: 'NO_INTERVIEW', answered_at: daysAgo(5), updated_at: daysAgo(1) } }).dashboard).toMatchObject({ ask: false, reason: 'ANSWERED' })
    expect(ev({ scan: scan(), outcome: { outcome: 'INTERVIEW' } }).dashboard.reason).toBe('ANSWERED')
    const waiting = ev({ scan: scan(), outcome: { outcome: 'STILL_APPLYING', updated_at: daysAgo(10) } }).dashboard
    expect(waiting).toMatchObject({ ask: false, reason: 'REASK_NOT_DUE', at: new Date(NOW + 20 * DAY).toISOString() })
    expect(ev({ scan: scan(), outcome: { outcome: 'STILL_APPLYING', updated_at: daysAgo(30) } }).dashboard).toMatchObject({ ask: true, reason: 'REASK_STILL_APPLYING' })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(366) }), outcome: { outcome: 'STILL_APPLYING', updated_at: daysAgo(100) } }).dashboard.reason).toBe('TOO_OLD')
  })
  it('email: delivered 30..120 days ago, unanswered, never mailed, attempts left', () => {
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(29) }) }).email).toMatchObject({ ask: false, reason: 'TOO_EARLY' })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(30) }) }).email).toMatchObject({ ask: true, reason: 'SEND' })
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(121) }) }).email.reason).toBe('TOO_OLD')
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(40), outcome_prompted_at: daysAgo(1) }) }).email.reason).toBe('ALREADY_PROMPTED')
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(40), outcome_prompt_attempts: 3 }) }).email.reason).toBe('ATTEMPTS_EXHAUSTED')
    expect(ev({ scan: scan({ first_delivered_at: daysAgo(40) }), outcome: { outcome: 'STILL_APPLYING' } }).email.reason).toBe('ANSWERED')   // the email asks once; the dashboard re-asks
  })
  it('email: needs an active, verified, opted-in, undeleted owner who was not mailed in the last 30 days', () => {
    const s = scan({ first_delivered_at: daysAgo(40) })
    expect(ev({ scan: s, user: user({ deleted_at: '2026-09-01' }) }).email.reason).toBe('ACCOUNT_DELETED')
    expect(ev({ scan: s, user: user({ status: 'BANNED' }) }).email.reason).toBe('ACCOUNT_NOT_ACTIVE')
    expect(ev({ scan: s, user: user({ email_verified: false }) }).email.reason).toBe('EMAIL_UNVERIFIED')
    expect(ev({ scan: s, user: user({ notify_outcome_followup: false }) }).email.reason).toBe('OPTED_OUT')
    expect(ev({ scan: s, user: user({ email: null }) }).email.reason).toBe('NO_EMAIL')
    expect(ev({ scan: s, user: null }).email.reason).toBe('NO_USER')
    expect(ev({ scan: s, recentlyEmailed: true }).email.reason).toBe('USER_COOLDOWN')
    expect(ev({ scan: scan({ user_id: null, first_delivered_at: daysAgo(40) }) }).email.reason).toBe('NO_OWNER')
  })
  it('isAskable refuses a refunded purchase and a failed rewrite', () => {
    const s = { user_id: USER, fix_purchased: true, fix_generated_at: '2026-09-01T00:00:00Z' }
    expect(lib.isAskable(s, USER)).toBe(true)
    expect(lib.isAskable(s, USER, { purchaseLive: false })).toBe(false)
    expect(lib.isAskable({ ...s, rewrite_failed: true }, USER)).toBe(false)
  })
})

describe('myStories', () => {
  const row = (over = {}) => ({
    scan_id: 's1', role_category: 'marketing', outcome: 'INTERVIEW', interview_count: 2, interview_after_days: 9, story_status: 'APPROVED',
    story_display_name: 'Amara O.', story_quote: 'A headline', story_text: 'The full story.', story_show_credential: true,
    answered_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-03T00:00:00Z', ...over,
  })
  it('returns the caller\'s own stories in full, newest first, and only the ones that exist (not NONE)', async () => {
    const { c, db } = outcomesSetup(() => ({ data: [row(), row({ scan_id: 's2', story_status: 'PENDING', story_show_credential: null, interview_count: null, story_display_name: null })], error: null }))
    const res = await c.myStories(ctxFor())
    expect(res.body.data.stories).toHaveLength(2)
    expect(res.body.data.stories[0]).toEqual({
      scanId: 's1', roleCategory: 'marketing', outcome: 'INTERVIEW', interviewCount: 2, interviewAfterDays: 9, status: 'APPROVED',
      displayName: 'Amara O.', quote: 'A headline', text: 'The full story.', showCredential: true, answeredAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
    })
    expect(res.body.data.stories[1]).toMatchObject({ interviewCount: null, displayName: null, showCredential: false })
    const q = db.calls[0]
    expect(q.table).toBe('scan_outcomes')
    expect(eqValue(q, 'user_id')).toBe(USER)
    expect(q.filters.some(f => f[0] === 'neq' && f[1] === 'story_status' && f[2] === 'NONE')).toBe(true)
    expect(q.cols).toContain('story_text')
  })
  it('is an empty list, not an error, for someone who has shared nothing', async () => {
    const { c } = outcomesSetup(() => ({ data: [], error: null }))
    expect((await c.myStories(ctxFor())).body).toEqual({ success: true, data: { stories: [] } })
  })
  it('lets a database failure through to the error handler instead of answering with a partial list', async () => {
    const { c } = outcomesSetup(() => ({ data: null, error: new Error('db down') }))
    await expect(c.myStories(ctxFor())).rejects.toThrow('db down')
  })
})

describe('sweepOutcomePrompts', () => {
  const NOW = Date.parse('2026-10-10T12:00:00Z')
  const user = (over = {}) => ({ email: 'a@x.y', name: 'Ann', status: 'ACTIVE', email_verified: true, deleted_at: null, notify_outcome_followup: true, ...over })
  const row = (id, uid, over = {}, userOver = {}) => ({ id, user_id: uid, fix_purchased: true, fix_payment_id: `p-${id}`, rewrite_failed: false, first_delivered_at: '2026-08-15T00:00:00Z', outcome_prompted_at: null, outcome_prompt_attempts: 0, users: user(userOver), ...over })
  function run(rows, { answered = [], sent = true, claimResult = [{ id: 'x' }], cooling = [], reversed = [] } = {}) {
    const sends = []
    const { c, db } = outcomesSetup(q => {
      if (q.table === 'scans' && q.op === 'select' && q.cols && q.cols.startsWith('user_id')) return { data: cooling.map(user_id => ({ user_id })), error: null }
      if (q.table === 'scans' && q.op === 'select') { const [f, t] = q.range || [0, 9999]; return { data: rows.slice(f, t + 1), error: null } }
      if (q.table === 'scan_outcomes') return { data: answered.map(scan_id => ({ scan_id })), error: null }
      if (q.table === 'payments') return { data: reversed.map(id => ({ id, status: 'DISPUTED' })), error: null }
      if (q.table === 'scans' && q.op === 'update') return { data: claimResult, error: null }
    }, { sendOutcomeFollowUp: async (...a) => { sends.push(a); return sent } })
    return c.sweepOutcomePrompts({ FRONTEND_URL: 'https://x' }, db, NOW).then(r => ({ r, sends, db }))
  }
  it('looks only at delivered fixes in the 30-to-120-day window (from the FIRST delivery) that were never prompted', async () => {
    const { db } = await run([])
    const q = db.calls[0]
    expect(q.filters).toContainEqual(['lte', 'first_delivered_at', new Date(NOW - 30 * 86400000).toISOString()])
    expect(q.filters).toContainEqual(['gte', 'first_delivered_at', new Date(NOW - 120 * 86400000).toISOString()])
    expect(q.filters).toContainEqual(['is', 'outcome_prompted_at', null])
    expect(q.filters).toContainEqual(['lt', 'outcome_prompt_attempts', constants.OUTCOME_EMAIL_MAX_ATTEMPTS])
  })
  it('sends one email per person even when several of their fixes qualify', async () => {
    const { r, sends } = await run([row('a', 'u1'), row('b', 'u1'), row('c', 'u2')])
    expect(r.sent).toBe(2)
    expect(sends).toHaveLength(2)
  })
  it('one email covers all of a person\'s fixes: the others are stamped as asked, so the next hours do not mail them again', async () => {
    const { db } = await run([row('a', 'u1'), row('b', 'u1')])
    const stamp = db.calls.filter(q => q.op === 'update' && q.patch.outcome_prompted_at && !q.patch.outcome_prompt_attempts)
    expect(stamp).toHaveLength(1)
    expect(eqValue(stamp[0], 'user_id')).toBe('u1')
    expect(stamp[0].filters).toContainEqual(['is', 'outcome_prompted_at', null])
  })
  it('does not mail someone who was already mailed within the cooldown', async () => {
    const { r, sends } = await run([row('a', 'u1'), row('b', 'u2')], { cooling: ['u1'] })
    expect(sends).toHaveLength(1)
    expect(r).toMatchObject({ sent: 1, skipped: 1 })
  })
  it('skips people who answered, opted out, are banned, deleted or unverified', async () => {
    const { r, sends } = await run([
      row('a', 'u1'), row('b', 'u2', {}, { notify_outcome_followup: false }), row('c', 'u3', {}, { status: 'BANNED' }),
      row('d', 'u4', {}, { deleted_at: '2026-09-01T00:00:00Z' }), row('e', 'u5', {}, { email_verified: false }), row('f', 'u6'),
    ], { answered: ['a'] })
    expect(sends).toHaveLength(1)
    expect(sends[0][3]).toBe('Ann')
    expect(r).toMatchObject({ sent: 1, skipped: 4 })
  })
  it('does not mail a refunded or disputed purchase, or a failed rewrite', async () => {
    const { r, sends } = await run([row('a', 'u1'), row('b', 'u2', { rewrite_failed: true }), row('c', 'u3')], { reversed: ['p-a'] })
    expect(sends).toHaveLength(1)
    expect(r.sent).toBe(1)
  })
  it('keeps reading past a full page of answered scans, so they cannot starve the people behind them', async () => {
    const page = constants.OUTCOME_EMAIL_BATCH * 3
    const answeredRows = Array.from({ length: page }, (_, i) => row(`old${i}`, `ou${i}`))
    const waiting = row('fresh', 'uf')
    const { r, sends } = await run([...answeredRows, waiting], { answered: answeredRows.map(x => x.id) })
    expect(sends).toHaveLength(1)
    expect(r.sent).toBe(1)
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
      if (q.table === 'scans' && q.op === 'select' && q.cols && q.cols.startsWith('user_id')) return { data: [], error: null }
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

describe('the follow-up email link', () => {
  it('lands on the My Story tab, which is where the question and the answers live', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'email.service.js'), 'utf8')
    expect(src).toMatch(/ANSWER_URL:\s+`\$\{env\.FRONTEND_URL\}\/dashboard\/story`/)
  })
})

describe('adminOutcomeAsk — the simulator', () => {
  const DAY = 86400000
  const ADMIN_SCAN = { id: SCAN, user_id: USER, fix_purchased: true, fix_tier: 'FIX', fix_payment_id: 'p1', rewrite_failed: false, first_delivered_at: new Date(Date.now() - 10 * DAY).toISOString(), fix_generated_at: new Date(Date.now() - 1 * DAY).toISOString(), outcome_prompted_at: null, outcome_prompt_attempts: 0, users: { email: 'secret@x.y', status: 'ACTIVE', email_verified: true, deleted_at: null, notify_outcome_followup: true } }
  function setup(over = {}) {
    return outcomesSetup(q => {
      if (q.table === 'scans' && q.cols && q.cols.startsWith('outcome_prompted_at')) return { data: over.mailed || [], error: null }
      if (q.table === 'scans') return { data: over.scan === undefined ? ADMIN_SCAN : over.scan, error: null }
      if (q.table === 'scan_outcomes') return { data: over.outcome || null, error: null }
      if (q.table === 'payments') return { data: (over.reversed || []).map(id => ({ id, status: 'REFUNDED' })), error: null }
    })
  }
  const call = (c, scanId = SCAN, days) => c.adminOutcomeAsk(ctxFor({ params: { scanId }, query: days === undefined ? {} : { days } }))
  it('explains now and N days ahead, from the first delivery, without exposing the address', async () => {
    const { c } = setup()
    const res = await call(c, SCAN, '25')
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.now_verdict.dashboard).toMatchObject({ ask: false, reason: 'TOO_EARLY' })
    expect(d.simulated.dashboard).toMatchObject({ ask: true })
    expect(d.simulated.email).toMatchObject({ ask: true, reason: 'SEND' })      // 35 days after delivery
    expect(d.schedule.dashboardFrom).toBeTruthy()
    expect(JSON.stringify(d)).not.toContain('secret@x.y')
  })
  it('reflects a refund and an answer already given', async () => {
    const { c } = setup({ reversed: ['p1'], outcome: { outcome: 'NO_INTERVIEW', answered_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } })
    const d = (await call(c, SCAN, '40')).body.data
    expect(d.facts).toMatchObject({ purchaseReversed: true, answer: 'NO_INTERVIEW' })
    expect(d.simulated.dashboard.reason).toBe('PURCHASE_REVERSED')
  })
  it('applies the 30-day cooldown from other mailed fixes of the same person', async () => {
    const { c } = setup({ mailed: [{ outcome_prompted_at: new Date(Date.now() - 2 * DAY).toISOString() }] })
    expect((await call(c, SCAN, '30')).body.data.now_verdict.email.reason).not.toBe('SEND')
    expect((await call(c, SCAN, '40')).body.data.simulated.email.reason).toBe('SEND')    // the cooldown has run out by then
  })
  it('400s a bad id or bad days, 404s a missing scan', async () => {
    const { c } = setup()
    expect((await call(c, 'x')).status).toBe(400)
    expect((await call(c, SCAN, '-1')).status).toBe(400)
    expect((await call(c, SCAN, '1.5')).status).toBe(400)
    expect((await call(c, SCAN, '731')).status).toBe(400)
    expect((await call(setup({ scan: null }).c, SCAN)).status).toBe(404)
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
