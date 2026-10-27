// Homepage evidence (migration 0070): what people tell us about a delivered fix, and what of it may
// be shown publicly. Pure functions only — controllers do the I/O.
//
// Two rules run through everything here:
//   * a public number must survive "based on what?" — so rates carry their response count and are
//     withheld below a minimum, and a percentage change needs a real base to compare against;
//   * a story is the author's words on OUR page — so it needs explicit consent, is vetted for the
//     scam text a branded page must never carry, is approved by an admin, and any later edit by its
//     author sends it back to review.

const { z } = require('zod')
const c = require('../config/constants')
const { cleanName, cleanNotes, hasSubstance, isPublicSafeName } = require('./text')

const OUTCOMES = Object.freeze({ INTERVIEW: 'INTERVIEW', NO_INTERVIEW: 'NO_INTERVIEW', STILL_APPLYING: 'STILL_APPLYING' })
// scans.verification_revoked_reason values written by a refund or a dispute (lib/verification.js REVOKE_REASON).
const REVERSED_REASONS = Object.freeze(['REFUND', 'DISPUTE'])
const STORY_STATUS = Object.freeze({ NONE: 'NONE', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' })

// A link, an address, or a phone-number-sized digit run has no place in a testimonial.
const LINK_OR_CONTACT = /(?:https?:\/\/|www\.)|[^\s@]+@[^\s@]+\.[^\s@]+|\b[a-z0-9-]+\.(?:com|net|org|io|dev|co|app|xyz|ly|me)\b/i
const PHONE_LIKE = /\d[\d\s().+-]{6,}\d/
const noContactDetails = (s) => !LINK_OR_CONTACT.test(s) && !PHONE_LIKE.test(s)

// "Amara", "Amara O.", "Mary Jane K." — short, name-shaped, nothing clickable.
function cleanDisplayName(input) {
  const name = cleanName(input)
  if (!name || !hasSubstance(name) || [...name].length > c.STORY_MAX_NAME) return null
  const tokens = name.split(' ')
  if (tokens.length > 3) return null
  return tokens.every(isPublicSafeName) && noContactDetails(name) ? name : null
}

const storySchema = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'Tick the box to confirm you are happy for us to publish your story.' }) }),
  displayName: z.string().transform(cleanDisplayName).pipe(z.string({ required_error: 'Enter a first name (and optionally an initial), without links or contact details.', invalid_type_error: 'Enter a first name (and optionally an initial), without links or contact details.' })),
  quote: z.string().transform(cleanName)
    .pipe(z.string().min(10, 'Write one sentence (at least 10 characters) for the headline.').max(c.STORY_MAX_QUOTE, `Keep the headline to ${c.STORY_MAX_QUOTE} characters.`)
      .refine(noContactDetails, 'Please leave links and contact details out of your story.')),
  text: z.string().transform(cleanNotes)
    .pipe(z.string().min(40, 'Tell the story in at least a couple of sentences (40 characters).').max(c.STORY_MAX_TEXT, `Keep the story under ${c.STORY_MAX_TEXT} characters.`)
      .refine(noContactDetails, 'Please leave links and contact details out of your story.')),
  showCredential: z.boolean().optional().default(false),
})

const baseSchema = z.object({
  scanId: z.string({ required_error: 'scanId required.', invalid_type_error: 'Invalid scan.' }).uuid('Invalid scan.'),
  outcome: z.enum(['INTERVIEW', 'NO_INTERVIEW', 'STILL_APPLYING'], { errorMap: () => ({ message: 'Choose one of the answers.' }) }),
  interviewCount: z.number({ invalid_type_error: 'Interview count must be a whole number.' }).int('Interview count must be a whole number.').min(1, 'Interview count must be between 1 and 99.').max(99, 'Interview count must be between 1 and 99.').optional(),
  interviewAfterDays: z.number({ invalid_type_error: 'Days must be a whole number.' }).int('Days must be a whole number.').min(0, 'Days must be between 0 and 365.').max(365, 'Days must be between 0 and 365.').optional(),
  // undefined = leave any existing story alone; null = withdraw it; object = submit / replace it
  // (validated against storySchema below so its field messages reach the person, not a union's "Invalid input").
  story: z.unknown().optional(),
})

// -> { ok: true, data } | { ok: false, message }
function parseSubmit(body) {
  const base = baseSchema.safeParse(body && typeof body === 'object' ? body : {})
  if (!base.success) return { ok: false, message: base.error.issues[0].message }
  const v = base.data
  if (v.outcome !== OUTCOMES.INTERVIEW) {
    if (v.interviewCount !== undefined || v.interviewAfterDays !== undefined) return { ok: false, message: 'Interview details only apply to an interview.' }
    if (v.story) return { ok: false, message: 'A story can only be shared along with an interview.' }
  }
  if (v.story === undefined || v.story === null) return { ok: true, data: v }
  if (typeof v.story !== 'object' || Array.isArray(v.story)) return { ok: false, message: 'Invalid story.' }
  const story = storySchema.safeParse(v.story)
  if (!story.success) return { ok: false, message: story.error.issues[0].message }
  return { ok: true, data: { ...v, story: story.data } }
}

// A fix is only reportable once it has actually been delivered to the person, and only while it is still a purchase: a refunded
// or disputed one has had its credential revoked and its files withdrawn, so neither an answer nor a story about it is evidence
// of anything. A delivery whose rewrite failed handed back the unchanged resume, so "did the fix lead to an interview?" has no
// subject either. `purchaseLive` fails open (true) when the payment could not be read: nobody is punished for our own outage.
function isAskable(scan, userId, { purchaseLive = true } = {}) {
  return !!scan && scan.user_id === userId && scan.fix_purchased === true && !!scan.fix_generated_at
    && scan.rewrite_failed !== true && purchaseLive !== false
}

// ── when a person is asked ──────────────────────────────────────────────────────────────────────────
// ONE definition, used three ways: the dashboard / My Story prompt and the follow-up email sweep (both pre-filter in SQL, then
// re-check each row here), and the admin simulator that answers "why is / isn't this scan being asked, and when will it be?".
//
//   dashboard   delivered >= 14 days ago and <= 120 days ago, never answered. A "still applying" answer is asked again 30 days
//               after it was given (for up to a year after delivery); any other answer is final unless the person reopens it.
//   email       delivered 30..120 days ago, never answered, never mailed, under 3 attempts, the person is active, verified and
//               has not switched the follow-up off, and no other follow-up went to them in the last 30 days.
//
// "Delivered" means the FIRST delivery (first_delivered_at, migration 0120), so a retry or an edit never moves the clock.
// Returns { ask, reason, at } — `at` is the moment the verdict is expected to change in the person's favour (when it is asked),
// or null when nothing will change it.
const DAY = 24 * 60 * 60 * 1000
const when = (ms) => new Date(ms).toISOString()
const ms = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null }

function deliveredAtMs(scan) { return ms(scan && (scan.first_delivered_at || scan.fix_generated_at)) }

function evaluateAsk({ scan, outcome = null, purchaseLive = true, user = null, recentlyEmailed = false }, nowMs = Date.now()) {
  const no = (reason, at = null) => ({ ask: false, reason, at: at == null ? null : when(at) })
  const base = (() => {
    if (!scan) return 'NO_SCAN'
    if (scan.fix_purchased !== true) return 'NOT_PURCHASED'
    if (deliveredAtMs(scan) == null) return 'NOT_DELIVERED'
    if (scan.rewrite_failed === true) return 'REWRITE_FAILED'
    if (purchaseLive === false) return 'PURCHASE_REVERSED'
    return null
  })()

  const dashboard = (() => {
    if (base) return no(base)
    const d = deliveredAtMs(scan), age = nowMs - d
    if (outcome) {
      if (outcome.outcome !== OUTCOMES.STILL_APPLYING) return no('ANSWERED')
      if (age > c.OUTCOME_REASK_MAX_AGE_DAYS * DAY) return no('TOO_OLD')
      const due = (ms(outcome.updated_at) ?? ms(outcome.answered_at) ?? nowMs) + c.OUTCOME_REASK_AFTER_DAYS * DAY
      return nowMs < due ? no('REASK_NOT_DUE', due) : { ask: true, reason: 'REASK_STILL_APPLYING', at: null }
    }
    if (age < c.OUTCOME_DASHBOARD_AFTER_DAYS * DAY) return no('TOO_EARLY', d + c.OUTCOME_DASHBOARD_AFTER_DAYS * DAY)
    if (age > c.OUTCOME_ASK_MAX_AGE_DAYS * DAY) return no('TOO_OLD')
    return { ask: true, reason: 'ASK', at: null }
  })()

  const email = (() => {
    if (base) return no(base)
    if (!scan.user_id) return no('NO_OWNER')
    if (outcome) return no('ANSWERED')
    if (scan.outcome_prompted_at) return no('ALREADY_PROMPTED')
    if ((scan.outcome_prompt_attempts || 0) >= c.OUTCOME_EMAIL_MAX_ATTEMPTS) return no('ATTEMPTS_EXHAUSTED')
    const d = deliveredAtMs(scan), age = nowMs - d
    if (age < c.OUTCOME_EMAIL_AFTER_DAYS * DAY) return no('TOO_EARLY', d + c.OUTCOME_EMAIL_AFTER_DAYS * DAY)
    if (age > c.OUTCOME_ASK_MAX_AGE_DAYS * DAY) return no('TOO_OLD')
    if (user) {
      if (!user.email) return no('NO_EMAIL')
      if (user.deleted_at) return no('ACCOUNT_DELETED')
      if (user.status !== 'ACTIVE') return no('ACCOUNT_NOT_ACTIVE')
      if (user.email_verified !== true) return no('EMAIL_UNVERIFIED')
      if (user.notify_outcome_followup === false) return no('OPTED_OUT')
    } else return no('NO_USER')
    if (recentlyEmailed) return no('USER_COOLDOWN')
    return { ask: true, reason: 'SEND', at: null }
  })()

  return { dashboard, email }
}

// What the story row should become after the author submits `incoming` over `existing`.
// An unchanged resubmission keeps its review state; ANY change to what readers would see (words,
// name, credential link) goes back to PENDING — an approved story must never silently turn into
// text nobody approved.
function nextStoryState(existing, incoming) {
  if (incoming === null) {
    return { story_consent: false, story_status: STORY_STATUS.NONE, story_display_name: null, story_quote: null, story_text: null, story_show_credential: false, story_moderated_at: null, story_moderated_by: null }
  }
  const next = {
    story_consent: true,
    story_display_name: incoming.displayName,
    story_quote: incoming.quote,
    story_text: incoming.text,
    story_show_credential: incoming.showCredential === true,
  }
  const same = existing && existing.story_status && existing.story_status !== STORY_STATUS.NONE
    && existing.story_display_name === next.story_display_name
    && existing.story_quote === next.story_quote
    && existing.story_text === next.story_text
    && existing.story_show_credential === next.story_show_credential
  if (same) return { ...next, story_status: existing.story_status }
  return { ...next, story_status: STORY_STATUS.PENDING, story_moderated_at: null, story_moderated_by: null }
}

// Share of the people who answered "yes" or "no" that said yes. "Still applying" is not an answer to
// "did it lead to an interview?" yet, so it is left out of both sides. Null until there are enough
// responses to mean anything.
function interviewRatePct(responses, interviews, min = c.OUTCOME_MIN_RESPONSES) {
  const r = Number(responses), i = Number(interviews)
  if (!Number.isFinite(r) || !Number.isFinite(i) || r < Math.max(min, 1) || i < 0 || i > r) return null
  return Math.round((i / r) * 100)
}

// Week-over-week style change, only against a base big enough that a percentage is not theatre.
const MIN_CHANGE_BASE = 5
function changePct(current, previous) {
  const cur = Number(current), prev = Number(previous)
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev < MIN_CHANGE_BASE) return null
  return Math.round(((cur - prev) / prev) * 100)
}

// The public face of one approved story row (with its scan embedded as `scans`). Everything is
// re-vetted on the way out, so a row written before a rule tightened is still covered.
function toPublicStory(row, id) {
  if (!row || row.story_status !== STORY_STATUS.APPROVED || row.outcome !== OUTCOMES.INTERVIEW) return null
  const displayName = cleanDisplayName(row.story_display_name)
  const quote = row.story_quote ? cleanName(row.story_quote) : ''
  const text = row.story_text ? cleanNotes(row.story_text) : ''
  if (!displayName || !quote || !text) return null
  const scan = row.scans || {}
  // A refunded or disputed purchase has had its credential and files withdrawn: its owner's story is not shown beside a product
  // they got their money back for (the answer itself still counts in the totals — dropping it would only remove the unhappy ones).
  if (REVERSED_REASONS.includes(scan.verification_revoked_reason)) return null
  const credentialLive = row.story_show_credential === true && !!scan.verification_code
    && (scan.verification_status || 'ACTIVE') === 'ACTIVE' && !scan.verification_revoked_at
  return {
    id,
    displayName,
    roleCategory: row.role_category || null,
    scoreBefore: Number.isFinite(scan.ats_score) ? scan.ats_score : null,
    scoreAfter: Number.isFinite(scan.fix_ats_score) ? scan.fix_ats_score : null,
    interviewCount: row.interview_count ?? null,
    interviewAfterDays: row.interview_after_days ?? null,
    quote,
    story: text,
    credentialCode: credentialLive ? scan.verification_code : null,
  }
}

module.exports = { OUTCOMES, STORY_STATUS, parseSubmit, storySchema, cleanDisplayName, isAskable, evaluateAsk, deliveredAtMs, nextStoryState, interviewRatePct, changePct, MIN_CHANGE_BASE, toPublicStory }
