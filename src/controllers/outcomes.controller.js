// "Did your fixed resume lead to an interview?" — the data behind every number on the homepage.
//
//   GET    /api/outcomes/pending           what to ask this person (and the state of their stories)
//   GET    /api/outcomes/mine              this person's own stories, in full (the dashboard's My Story tab)
//   PUT    /api/outcomes                   answer (or change the answer), optionally with a story
//   DELETE /api/outcomes/:scanId/story     take a story back; the answer itself stays
//
// plus sweepOutcomePrompts(), the hourly job that emails the question once, a month after delivery,
// to people who have not answered it on the dashboard.
//
// Only a DELIVERED fix can be asked about (fix_purchased and fix_generated_at): an interview rate over
// people who never received anything would measure nothing. Answers are the person's own and can be
// changed at any time; a story is never public until an admin approves it (admin-stories controller).

const { getSupabase } = require('../config/supabase')
const constants = require('../config/constants')
const { UUID_RE } = require('../middleware/validateUuidParam')
const emailService = require('../services/email.service')
const { parseSubmit, isAskable, nextStoryState, STORY_STATUS, OUTCOMES } = require('../lib/outcomes')
const { signLeadToken, verifyLeadToken, leadLinkSecrets } = require('../lib/leadTokens')

const DAY_MS = 24 * 60 * 60 * 1000
const PENDING_SHOWN = 3
const MY_STORIES_SHOWN = 50

const iso = (ms) => new Date(ms).toISOString()

async function readJson(c) {
  try { return await c.req.json() } catch (_) { return null }
}

// GET /api/outcomes/pending
async function pendingOutcomes(c) {
  const user = c.get('user')
  const supabase = getSupabase(c.env)
  const cutoff = iso(Date.now() - constants.OUTCOME_DASHBOARD_AFTER_DAYS * DAY_MS)

  const { data: scans, error } = await supabase.from('scans')
    .select('id, job_title, role_category, ats_score, fix_ats_score, fix_generated_at')
    .eq('user_id', user.id).eq('fix_purchased', true)
    .not('fix_generated_at', 'is', null).lte('fix_generated_at', cutoff)
    .order('fix_generated_at', { ascending: false }).limit(25)
  if (error) throw error

  const ids = (scans || []).map(s => s.id)
  let answeredIds = new Set()
  if (ids.length) {
    const { data: answered, error: aErr } = await supabase.from('scan_outcomes').select('scan_id').in('scan_id', ids)
    if (aErr) throw aErr
    answeredIds = new Set((answered || []).map(r => r.scan_id))
  }
  const pending = (scans || []).filter(s => !answeredIds.has(s.id)).slice(0, PENDING_SHOWN).map(s => ({
    scanId: s.id, jobTitle: s.job_title || null, roleCategory: s.role_category || null,
    scoreBefore: s.ats_score ?? null, scoreAfter: s.fix_ats_score ?? null, deliveredAt: s.fix_generated_at,
  }))

  const { data: stories, error: sErr } = await supabase.from('scan_outcomes')
    .select('scan_id, outcome, story_status, story_display_name, story_quote, answered_at')
    .eq('user_id', user.id).neq('story_status', STORY_STATUS.NONE)
    .order('answered_at', { ascending: false }).limit(10)
  if (sErr) throw sErr

  return c.json({ success: true, data: {
    pending,
    stories: (stories || []).map(r => ({ scanId: r.scan_id, status: r.story_status, displayName: r.story_display_name, quote: r.story_quote, answeredAt: r.answered_at })),
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
    .select('id, user_id, role_category, fix_purchased, fix_generated_at').eq('id', v.scanId).maybeSingle()
  if (error) throw error
  // Someone else's scan and a missing one are the same answer: no scan id is confirmed to a stranger.
  if (!scan || scan.user_id !== user.id) return c.json({ success: false, message: 'Scan not found.' }, 404)
  if (!isAskable(scan, user.id)) return c.json({ success: false, message: 'You can report an outcome once your fixed resume has been delivered.' }, 409)

  const { data: existing, error: exErr } = await supabase.from('scan_outcomes')
    .select('story_status, story_display_name, story_quote, story_text, story_show_credential').eq('scan_id', v.scanId).maybeSingle()
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
  if (!existing) row.answered_at = now

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
// A month after a fix was delivered, ask once. One scan per person per run; a scan is claimed before
// the send (so two overlapping runs cannot both mail it) and released again if the send did not go,
// up to OUTCOME_EMAIL_MAX_ATTEMPTS. Skips anyone who has switched the interview follow-up off (Settings), is banned or
// deleted, never verified their address, or has already answered.
async function sweepOutcomePrompts(env, supabase, nowMs = Date.now()) {
  const out = { candidates: 0, sent: 0, failed: 0, skipped: 0 }
  const newest = iso(nowMs - constants.OUTCOME_EMAIL_AFTER_DAYS * DAY_MS)
  const oldest = iso(nowMs - constants.OUTCOME_EMAIL_MAX_AGE_DAYS * DAY_MS)

  const { data: rows, error } = await supabase.from('scans')
    .select('id, user_id, outcome_prompt_attempts, users(email, name, status, email_verified, deleted_at, notify_outcome_followup)')
    .eq('fix_purchased', true).not('fix_generated_at', 'is', null)
    .lte('fix_generated_at', newest).gte('fix_generated_at', oldest)
    .is('outcome_prompted_at', null).lt('outcome_prompt_attempts', constants.OUTCOME_EMAIL_MAX_ATTEMPTS)
    .not('user_id', 'is', null)
    .order('fix_generated_at', { ascending: true }).limit(constants.OUTCOME_EMAIL_BATCH * 3)
  if (error) return { ...out, error: error.message }

  const ids = (rows || []).map(r => r.id)
  let answered = new Set()
  if (ids.length) {
    const { data: a, error: aErr } = await supabase.from('scan_outcomes').select('scan_id').in('scan_id', ids)
    if (aErr) return { ...out, error: aErr.message }
    answered = new Set((a || []).map(r => r.scan_id))
  }

  const perUser = new Map()
  for (const r of rows || []) {
    if (answered.has(r.id) || perUser.has(r.user_id)) continue
    const u = r.users
    const eligible = u && u.email && !u.deleted_at && u.status === 'ACTIVE' && u.email_verified === true && u.notify_outcome_followup !== false
    if (!eligible) { out.skipped++; continue }
    perUser.set(r.user_id, r)
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
    if (ok) { out.sent++; continue }
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

module.exports = { pendingOutcomes, myStories, submitOutcome, withdrawStory, sweepOutcomePrompts, unsubscribeFollowUp, unsubscribeFollowUpRedirect, followUpUnsubscribeUrl }
