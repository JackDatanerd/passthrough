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

// A fix is only askable about once it has actually been delivered to the person.
function isAskable(scan, userId) {
  return !!scan && scan.user_id === userId && scan.fix_purchased === true && !!scan.fix_generated_at
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

module.exports = { OUTCOMES, STORY_STATUS, parseSubmit, storySchema, cleanDisplayName, isAskable, nextStoryState, interviewRatePct, changePct, MIN_CHANGE_BASE, toPublicStory }
