// "Did your fixed resume lead to an interview?" — the data behind every number on the homepage.
//
//   GET    /api/outcomes/pending           what to ask this person (and the state of their stories)
//   GET    /api/outcomes/mine              this person's own stories, in full (the dashboard's My Story tab)
//   PUT    /api/outcomes                   answer (or change the answer), optionally with a story
//   DELETE /api/outcomes/:scanId/story     take a story back; the answer itself stays
//
// plus sweepOutcomePrompts(), the hourly job that emails the question once, a month after delivery,
// to people who have not answered it on the dashboard, and adminOutcomeAsk(), which explains (and simulates) the verdict.
//
// WHO IS ASKED, and when, is defined once in lib/outcomes.js evaluateAsk; the SQL filters below are only a pre-filter and every
// row is re-checked there. Only a DELIVERED, still-live fix can be asked about: an interview rate over people who never received
// anything (or who got their money back) would measure nothing. Time is measured from the FIRST delivery (migration 0120).
// Answers are the person's own and can be changed at any time (/pending lists them for exactly that); a story is never public
// until an admin approves it (admin-stories controller).

const { getSupabase } = require('../config/supabase')
const constants = require('../config/constants')
const { UUID_RE } = require('../middleware/validateUuidParam')
const emailService = require('../services/email.service')
const { parseSubmit, isAskable, nextStoryState, evaluateAsk, STORY_STATUS, OUTCOMES } = require('../lib/outcomes')
const { signLeadToken, verifyLeadToken, leadLinkSecrets } = require('../lib/leadTokens')

const DAY_MS = 24 * 60 * 60 * 1000
const PENDING_SHOWN = 3
const MY_STORIES_SHOWN = 50
const ANSWERS_SHOWN = 10
const ANSWERS_READ = 500        // a person's own answers: one row per delivered scan, so this is far past any real account
const PENDING_PAGE = 25
const PENDING_MAX_PAGES = 8
const REVERSED = ['REFUNDED', 'DISPUTED']

const iso = (ms) => new Date(ms).toISOString()

async function readJson(c) {
  try { return await c.req.json() } catch (_) { return null }
}

// Ids (of the given payments) whose purchase was refunded or is disputed. Fails open: a payment that cannot be read does not
// stop anyone being asked (same rule as scan.controller purchaseIsLive).
async function reversedPayments(supabase, paymentIds) {
  const ids = [...new Set((paymentIds || []).filter(Boolean))]
  if (!ids.length) return new Set()
  try {
    const { data, error } = await supabase.from('payments').select('id, status').in('id', ids)
    if (error) return new Set()
    return new Set((data || []).filter(p => REVERSED.includes(p.status)).map(p => p.id))
  } catch (_) { return new Set() }
}

// GET /api/outcomes/pending
//   pending   up to 3 fixes to ask about now (see evaluateAsk): delivered 14..120 days ago and never answered, or a "still
//             applying" answer that is 30+ days old
//   answers   the person's recent answers, so any of them can be changed (My Story shows them)
//   stories   the state of the stories they have shared
async function pendingOutcomes(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const nowMs = Date.now()

  const { data: outs, error: oErr } = await supabase.from('scan_outcomes')
    .select('scan_id, outcome, interview_count, interview_after_days, story_status, story_display_name, story_quote, answered_at, updated_at, ' +
      'scans(job_title, role_category, fix_tier, first_delivered_at, fix_generated_at)')
    .eq('user_id', user.id).order('updated_at', { ascending: false }).limit(ANSWERS_READ)
  if (oErr) throw oErr
  const outcomes = new Map((outs || []).map(r => [r.scan_id, r]))

  // Read the person's delivered fixes newest first, a page at a time, until three are askable: an answered scan must never push an
  // unanswered one out of view (it used to: the newest 25 were read and THEN the answered ones dropped).
  const pending = []
  const oldest = iso(nowMs - constants.OUTCOME_REASK_MAX_AGE_DAYS * DAY_MS)
  const newest = iso(nowMs - constants.OUTCOME_DASHBOARD_AFTER_DAYS * DAY_MS)
  for (let page = 0; page < PENDING_MAX_PAGES && pending.length < PENDING_SHOWN; page++) {
    const { data: scans, error } = await supabase.from('scans')
      .select('id, user_id, job_title, role_category, fix_tier, ats_score, fix_ats_score, fix_purchased, fix_payment_id, rewrite_failed, first_delivered_at, fix_generated_at')
      .eq('user_id', user.id).eq('fix_purchased', true)
      .not('first_delivered_at', 'is', null).lte('first_delivered_at', newest).gte('first_delivered_at', oldest)
      .order('first_delivered_at', { ascending: false }).order('id', { ascending: true })
      .range(page * PENDING_PAGE, page * PENDING_PAGE + PENDING_PAGE - 1)
    if (error) throw error
    const rows = scans || []
    const askable = rows.filter(s => evaluateAsk({ scan: s, outcome: outcomes.get(s.id) || null }, nowMs).dashboard.ask)
    const reversed = await reversedPayments(supabase, askable.map(s => s.fix_payment_id))
    for (const s of askable) {
      if (reversed.has(s.fix_payment_id) || pending.length >= PENDING_SHOWN) continue
      pending.push({
        scanId: s.id, jobTitle: s.job_title || null, roleCategory: s.role_category || null, fixTier: s.fix_tier || null,
        scoreBefore: s.ats_score ?? null, scoreAfter: s.fix_ats_score ?? null,
        deliveredAt: s.first_delivered_at || s.fix_generated_at, reask: outcomes.has(s.id),
      })
    }
    if (rows.length < PENDING_PAGE) break
  }

  const asked = new Set(pending.map(p => p.scanId))
  const answers = (outs || []).filter(r => r.scans && !asked.has(r.scan_id)).slice(0, ANSWERS_SHOWN).map(r => ({
    scanId: r.scan_id, outcome: r.outcome, interviewCount: r.interview_count ?? null, interviewAfterDays: r.interview_after_days ?? null,
    storyStatus: r.story_status || STORY_STATUS.NONE, jobTitle: r.scans.job_title || null, roleCategory: r.scans.role_category || null,
    fixTier: r.scans.fix_tier || null, deliveredAt: r.scans.first_delivered_at || r.scans.fix_generated_at || null,
    answeredAt: r.answered_at, updatedAt: r.updated_at,
  }))

  const stories = (outs || []).filter(r => r.story_status && r.story_status !== STORY_STATUS.NONE)
    .sort((a, b) => String(b.answered_at).localeCompare(String(a.answered_at))).slice(0, 10)

  return c.json({ success: true, data: {
    pending, answers,
    stories: stories.map(r => ({ scanId: r.scan_id, status: r.story_status, displayName: r.story_display_name, quote: r.story_quote, answeredAt: r.answered_at })),
  } })
}

// GET /api/outcomes/mine
// Every story this person has shared, with the words they wrote and where each stands. /pending only carries
// a headline per story (it feeds the prompt on the dashboard); this is the full text, for the My Story tab, so
// it can be read, edited and taken down. Only ever the caller's own rows. A scan that was deleted took its story
// with it (see the trigger in 0074), so what is listed here is what still exists.
async function myStories(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('scan_outcomes')
    .select('scan_id, role_category, outcome, interview_count, interview_after_days, story_status, story_display_name, story_quote, story_text, story_show_credential, answered_at, updated_at')
    .eq('user_id', user.id).neq('story_status', STORY_STATUS.NONE)
    .order('answered_at', { ascending: false }).limit(MY_STORIES_SHOWN)
  if (error) throw error
  return c.json({ success: true, data: { stories: (data || []).map(r => ({
    scanId: r.scan_id, roleCategory: r.role_category || null, outcome: r.outcome,
    interviewCount: r.interview_count ?? null, interviewAfterDays: r.interview_after_days ?? null,
    status: r.story_status, displayName: r.story_display_name || null, quote: r.story_quote || null, text: r.story_text || null,
    showCredential: r.story_show_credential === true, answeredAt: r.answered_at, updatedAt: r.updated_at,
  })) } })
}

// PUT /api/outcomes
async function submitOutcome(c) {
  const user = c.get('user')
  const parsed = parseSubmit(await readJson(c))
  if (!parsed.ok) return c.json({ success: false, message: parsed.message }, 400)
  const v = parsed.data
  const supabase = getSupabase(c.env)

  const { data: scan, error } = await supabase.from('scans')
    .select('id, user_id, role_category, fix_purchased, fix_generated_at, fix_payment_id, rewrite_failed').eq('id', v.scanId).maybeSingle()
  if (error) throw error
  // Someone else's scan and a missing one are the same answer: no scan id is confirmed to a stranger.
  if (!scan || scan.user_id !== user.id) return c.json({ success: false, message: 'Scan not found.' }, 404)
  if (!isAskable(scan, user.id)) return c.json({ success: false, message: 'You can report an outcome once your fixed resume has been delivered.' }, 409)
  if ((await reversedPayments(supabase, [scan.fix_payment_id])).size) return c.json({ success: false, message: 'This purchase was refunded or is under dispute, so there is nothing to report on.' }, 409)

  const { data: existing, error: exErr } = await supabase.from('scan_outcomes')
    .select('outcome, story_status, story_display_name, story_quote, story_text, story_show_credential').eq('scan_id', v.scanId).maybeSingle()
  if (exErr) throw exErr

  const now = new Date().toISOString()
  const row = {
    scan_id: v.scanId,
    user_id: user.id,
    role_category: scan.role_category || null,
    outcome: v.outcome,
    interview_count: v.outcome === OUTCOMES.INTERVIEW ? (v.interviewCount ?? null) : null,
    interview_after_days: v.outcome === OUTCOMES.INTERVIEW ? (v.interviewAfterDays ?? null) : null,
    updated_at: now,
  }
  // answered_at is the date an answer counts from (the hot-fields windows in public_hot_categories read it). A first answer stamps
  // it; so does an answer that BECOMES "interview": someone who said "not yet" and got the call two months later is reporting an
  // interview today, and counting it at their first answer's date would put it outside every window, so it would never show.
  if (!existing || (existing.outcome !== OUTCOMES.INTERVIEW && v.outcome === OUTCOMES.INTERVIEW)) row.answered_at = now

  // story: undefined keeps whatever is there; changing the answer away from "interview" ends a story
  // (the database refuses a story without an interview behind it, and it would no longer be true).
  let storyPatch = {}
  if (v.story !== undefined) storyPatch = nextStoryState(existing, v.story)
  else if (v.outcome !== OUTCOMES.INTERVIEW && existing && existing.story_status && existing.story_status !== STORY_STATUS.NONE) storyPatch = nextStoryState(existing, null)
  Object.assign(row, storyPatch)

  const { error: upErr } = await supabase.from('scan_outcomes').upsert(row, { onConflict: 'scan_id' })
  if (upErr) throw upErr

  const storyStatus = storyPatch.story_status ?? existing?.story_status ?? STORY_STATUS.NONE
  return c.json({ success: true, message: 'Thank you — that genuinely helps.', data: { outcome: v.outcome, storyStatus } })
}

// DELETE /api/outcomes/:scanId/story
async function withdrawStory(c) {
  const user = c.get('user')
  const scanId = c.req.param('scanId')
  if (!UUID_RE.test(scanId || '')) return c.json({ success: false, message: 'Invalid ID.' }, 400)
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('scan_outcomes')
    .update({ ...nextStoryState(null, null), updated_at: new Date().toISOString() })
    .eq('scan_id', scanId).eq('user_id', user.id).neq('story_status', STORY_STATUS.NONE)
    .select('scan_id')
  if (error) throw error
  if (!data || !data.length) return c.json({ success: false, message: 'No story to withdraw.' }, 404)
  return c.json({ success: true, message: 'Your story has been taken down.' })
}

// ── follow-up email sweep ───────────────────────────────────────────────────────────────────────
// A month after a fix was first delivered, ask once. One scan per person per run; a scan is claimed before the send (so two
// overlapping runs cannot both mail it) and released again if the send did not go, up to OUTCOME_EMAIL_MAX_ATTEMPTS. What the
// verdict for each scan is lives in lib/outcomes.js evaluateAsk (answered, opted out, banned, deleted, unverified, refunded,
// a failed rewrite, too early / too old, mailed this person within the cooldown).
//
// The queue is read oldest first in PAGES and every page is judged before the next is read: answered scans and ineligible people
// are never stamped (an answer can be changed and an address can be verified later), so they stay in the query's result for as
// long as they are in the window. Reading one fixed-size page let a few hundred of them starve everyone behind them.
//
// One email covers all of a person's fixes (the dashboard lists up to three), so when it goes, their other scans in the window are
// stamped as asked too; and nobody is mailed again within OUTCOME_EMAIL_USER_COOLDOWN_DAYS.
async function sweepOutcomePrompts(env, supabase, nowMs = Date.now()) {
  const out = { candidates: 0, sent: 0, failed: 0, skipped: 0 }
  const newest = iso(nowMs - constants.OUTCOME_EMAIL_AFTER_DAYS * DAY_MS)
  const oldest = iso(nowMs - constants.OUTCOME_ASK_MAX_AGE_DAYS * DAY_MS)
  const cooldownSince = iso(nowMs - constants.OUTCOME_EMAIL_USER_COOLDOWN_DAYS * DAY_MS)
  const pageSize = constants.OUTCOME_EMAIL_BATCH * 3

  const perUser = new Map()
  for (let page = 0; page < constants.OUTCOME_SWEEP_MAX_PAGES && perUser.size < constants.OUTCOME_EMAIL_BATCH; page++) {
    const { data: rows, error } = await supabase.from('scans')
      .select('id, user_id, fix_purchased, fix_payment_id, rewrite_failed, first_delivered_at, outcome_prompted_at, outcome_prompt_attempts, users(email, name, status, email_verified, deleted_at, notify_outcome_followup)')
      .eq('fix_purchased', true).not('first_delivered_at', 'is', null)
      .lte('first_delivered_at', newest).gte('first_delivered_at', oldest)
      .is('outcome_prompted_at', null).lt('outcome_prompt_attempts', constants.OUTCOME_EMAIL_MAX_ATTEMPTS)
      .not('user_id', 'is', null)
      .order('first_delivered_at', { ascending: true }).order('id', { ascending: true })
      .range(page * pageSize, page * pageSize + pageSize - 1)
    if (error) return { ...out, error: error.message }
    const batch = rows || []
    if (!batch.length) break

    const ids = batch.map(r => r.id)
    const { data: a, error: aErr } = await supabase.from('scan_outcomes').select('scan_id').in('scan_id', ids)
    if (aErr) return { ...out, error: aErr.message }
    const answered = new Set((a || []).map(r => r.scan_id))

    const owners = [...new Set(batch.map(r => r.user_id))]
    const { data: recent, error: rErr } = await supabase.from('scans').select('user_id')
      .in('user_id', owners).gte('outcome_prompted_at', cooldownSince)
    if (rErr) return { ...out, error: rErr.message }
    const cooling = new Set((recent || []).map(r => r.user_id))
    const reversed = await reversedPayments(supabase, batch.map(r => r.fix_payment_id))

    for (const r of batch) {
      if (answered.has(r.id) || perUser.has(r.user_id)) continue
      const verdict = evaluateAsk({
        scan: r, outcome: null, user: r.users, purchaseLive: !reversed.has(r.fix_payment_id), recentlyEmailed: cooling.has(r.user_id),
      }, nowMs).email
      if (!verdict.ask) {
        // Only the people we would otherwise have mailed count as skipped; a scan that simply is not due, or that is already
        // settled, is not news.
        if (['ACCOUNT_DELETED', 'ACCOUNT_NOT_ACTIVE', 'EMAIL_UNVERIFIED', 'OPTED_OUT', 'NO_EMAIL', 'NO_USER', 'USER_COOLDOWN'].includes(verdict.reason)) out.skipped++
        continue
      }
      perUser.set(r.user_id, r)
    }
    if (batch.length < pageSize) break
  }
  out.candidates = perUser.size

  for (const r of [...perUser.values()].slice(0, constants.OUTCOME_EMAIL_BATCH)) {
    const claimedAt = new Date(nowMs).toISOString()
    const { data: claimed, error: cErr } = await supabase.from('scans')
      .update({ outcome_prompted_at: claimedAt, outcome_prompt_attempts: (r.outcome_prompt_attempts || 0) + 1 })
      .eq('id', r.id).is('outcome_prompted_at', null).select('id')
    if (cErr || !claimed || !claimed.length) continue   // another run has it
    let ok = false
    try { ok = await emailService.sendOutcomeFollowUp(env, supabase, r.users.email, r.users.name, { unsubscribeUrl: await followUpUnsubscribeUrl(env, r.users.email) }) } catch (err) { console.error('Outcome follow-up send failed:', err.message) }
    if (ok) {
      out.sent++
      // This one email covers the person's other fixes in the window too (the dashboard lists them): do not mail them again for each.
      const { error: sibErr } = await supabase.from('scans').update({ outcome_prompted_at: claimedAt })
        .eq('user_id', r.user_id).eq('fix_purchased', true).is('outcome_prompted_at', null)
        .gte('first_delivered_at', oldest).lte('first_delivered_at', newest)
      if (sibErr) console.error(`Outcome follow-up sibling stamp failed for ${r.user_id}:`, sibErr.message)
      continue
    }
    out.failed++
    const { error: relErr } = await supabase.from('scans').update({ outcome_prompted_at: null }).eq('id', r.id)
    if (relErr) console.error(`Outcome follow-up release failed for ${r.id}:`, relErr.message)
  }
  return out
}

// ── One-click unsubscribe for the follow-up email (cross-cutting infra round 6) ──────────────────────────────────
// The interview follow-up is a recurring, non-transactional mail; it had a Settings link in the body but no
// List-Unsubscribe header, so a mail client's own "unsubscribe" button was missing and every opt-out cost a sign-in.
// The link is a signed token (purpose 'followup', lib/leadTokens.js) carrying the address — no account lookup to
// guess, nothing to enumerate. A GET never changes anything (scanners and link previewers issue them): it only sends
// the visitor to Settings, where the switch is.
async function followUpUnsubscribeUrl(env, email) {
  try {
    const sign = leadLinkSecrets(env).sign
    if (!sign) return null
    const origin = await require('./employer-leads.controller').configuredApiOrigin(env)
    if (!origin) return null
    return `${origin}/api/outcomes/unsubscribe?token=${await signLeadToken(sign, 'followup', email)}`
  } catch (err) {
    console.error('Outcome follow-up unsubscribe link not built:', err && err.message)
    return null   // the mail still goes, just without the header
  }
}

// POST /api/outcomes/unsubscribe?token=…  — RFC 8058 one-click (a mail provider posts here).
async function unsubscribeFollowUp(c) {
  const token = c.req.query('token') || ''
  const email = token.length >= 10 && token.length <= 700
    ? await verifyLeadToken(leadLinkSecrets(c.env).verify, 'followup', token) : null
  if (!email) return c.json({ success: false, message: 'This link is not valid.' }, 400)
  const { error } = await getSupabase(c.env).from('users')
    .update({ notify_outcome_followup: false }).eq('email', email).is('deleted_at', null)
  if (error) throw error   // a 5xx, so the provider may retry
  return c.json({ success: true, message: "You won't get the interview follow-up email again. You can switch it back on in Settings." })
}

// GET /api/outcomes/unsubscribe?token=…  — a mail client that only follows the URL. Does not look at the token.
function unsubscribeFollowUpRedirect(c) {
  const base = String((c.env && c.env.FRONTEND_URL) || '').replace(/\/+$/, '')
  return c.redirect(`${base}/dashboard/settings`, 302)
}

// GET /api/admin/outcome-ask/:scanId?days=N   (admin only)
// "Why is — or isn't — this scan being asked whether it led to an interview, and when will it be?" Runs the same evaluateAsk the
// dashboard and the sweep use, against the scan's real row, now and (with days=N, 0..730) N days from now, so the conditions can
// be simulated without touching data. Read-only; returns flags about the owner, never their address.
async function adminOutcomeAsk(c) {
  const scanId = c.req.param('scanId')
  if (!UUID_RE.test(scanId || '')) return c.json({ success: false, message: 'Invalid ID.' }, 400)
  const raw = c.req.query('days')
  const days = raw === undefined || raw === '' ? 0 : Number(raw)
  if (!Number.isInteger(days) || days < 0 || days > 730) return c.json({ success: false, message: 'days must be a whole number from 0 to 730.' }, 400)
  const supabase = getSupabase(c.env)

  const { data: scan, error } = await supabase.from('scans')
    .select('id, user_id, fix_purchased, fix_tier, fix_payment_id, rewrite_failed, first_delivered_at, fix_generated_at, outcome_prompted_at, outcome_prompt_attempts, users(email, status, email_verified, deleted_at, notify_outcome_followup)')
    .eq('id', scanId).maybeSingle()
  if (error) throw error
  if (!scan) return c.json({ success: false, message: 'Scan not found.' }, 404)

  const { data: outcome, error: oErr } = await supabase.from('scan_outcomes')
    .select('outcome, answered_at, updated_at').eq('scan_id', scanId).maybeSingle()
  if (oErr) throw oErr
  const reversed = await reversedPayments(supabase, [scan.fix_payment_id])
  let prompted = []
  if (scan.user_id) {
    const { data: mailed, error: mErr } = await supabase.from('scans').select('outcome_prompted_at')
      .eq('user_id', scan.user_id).not('outcome_prompted_at', 'is', null).limit(100)
    if (mErr) throw mErr
    prompted = (mailed || []).map(r => Date.parse(r.outcome_prompted_at)).filter(Number.isFinite)
  }

  const nowMs = Date.now()
  const at = (atMs) => evaluateAsk({
    scan, outcome: outcome || null, user: scan.users || null, purchaseLive: !reversed.has(scan.fix_payment_id),
    recentlyEmailed: prompted.some(t => t >= atMs - constants.OUTCOME_EMAIL_USER_COOLDOWN_DAYS * DAY_MS && t <= atMs),
  }, atMs)
  const simMs = nowMs + days * DAY_MS
  const delivered = scan.first_delivered_at || scan.fix_generated_at || null
  const d = delivered ? Date.parse(delivered) : null
  const u = scan.users || null
  return c.json({ success: true, data: {
    scanId, now: iso(nowMs), simulatedAt: iso(simMs), days,
    facts: {
      fixPurchased: scan.fix_purchased === true, fixTier: scan.fix_tier || null, firstDeliveredAt: delivered, rewriteFailed: scan.rewrite_failed === true,
      purchaseReversed: reversed.has(scan.fix_payment_id), answer: outcome ? outcome.outcome : null, answeredAt: outcome ? outcome.answered_at : null,
      emailedAt: scan.outcome_prompted_at || null, emailAttempts: scan.outcome_prompt_attempts || 0,
      owner: u ? { status: u.status, emailVerified: u.email_verified === true, deleted: !!u.deleted_at, followUpOn: u.notify_outcome_followup !== false } : null,
    },
    schedule: d == null ? null : {
      dashboardFrom: iso(d + constants.OUTCOME_DASHBOARD_AFTER_DAYS * DAY_MS),
      emailFrom: iso(d + constants.OUTCOME_EMAIL_AFTER_DAYS * DAY_MS),
      askUntil: iso(d + constants.OUTCOME_ASK_MAX_AGE_DAYS * DAY_MS),
    },
    now_verdict: at(nowMs), simulated: at(simMs),
  } })
}

module.exports = { adminOutcomeAsk, pendingOutcomes, myStories, submitOutcome, withdrawStory, sweepOutcomePrompts, unsubscribeFollowUp, unsubscribeFollowUpRedirect, followUpUnsubscribeUrl }
