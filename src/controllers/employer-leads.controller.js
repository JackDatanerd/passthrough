const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')
const { leadRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')
const constants = require('../config/constants')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { normalizeCode, isPlausibleCode } = require('../lib/verification')
const { isRangeError } = require('../lib/db')
const { sha256 } = require('../lib/crypto')
const { signLeadToken, verifyLeadToken, leadLinkSecrets } = require('../lib/leadTokens')
const { logAdminAction } = require('../lib/adminAudit')
const { verifyTurnstile } = require('../lib/turnstile')
const { clientIp } = require('../lib/clientIp')
const { hitQuota, refundQuota } = require('../middleware/rateLimiter')

// ── Vocabulary ──────────────────────────────────────────────────────────────
// A lead that reaches either of these has, by definition, been contacted: contacted_at is stamped
// the first time it does (a lead moved straight to CONVERTED used to keep a blank "Contacted at").
const CONTACTED_STATUSES = ['CONTACTED', 'CONVERTED']
// Statuses match lead_status_enum (migration 0018). Sources are whitelisted
// rather than accepted as a client string: the value only exists for internal
// reporting and a submitter shouldn't be able to set it to anything.
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']
const LEAD_SOURCES  = ['verification_page', 'homepage']
// The SAME taxonomy candidates' scans are tagged with (constants.js) — that
// shared vocabulary is what makes "candidates matching your role" answerable.
const ROLE_CATEGORIES = constants.ROLE_CATEGORIES

// ── Input hygiene ───────────────────────────────────────────────────────────
// Everything a stranger types here ends up in an email to the owner and a
// table an admin reads. Control characters (newlines especially) let a
// submitter forge extra "email: ceo@bigco.com" lines in that notification, so
// they're collapsed to a space; runs of whitespace are squeezed; ends trimmed.
//
// Invisible and direction-changing format characters are removed outright
// (not turned into spaces): a name made only of zero-width spaces used to pass
// `min(1)` and render as a blank row, and a right-to-left override lets one
// field visually reorder the text after it in the admin table and in the
// owner's email. ZWJ / ZWNJ (U+200D / U+200C) are deliberately kept — emoji
// sequences and Persian/Indic scripts need them.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// BUG FIX (fresh audit pass 2, Section 5): the list below used to miss two
// families. (1) The Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) are
// category Lo — LETTERS — so a name made only of them passed hasSubstance()
// below and rendered as a blank row, the exact outcome this list exists to
// prevent. (2) U+061C ARABIC LETTER MARK is a direction-changing control like
// the LRM/RLM already listed, and U+034F / U+17B4 / U+17B5 are default-
// ignorable marks with no visible glyph of their own.
//
// BUG FIX (independent audit round 7, Section 5): the pattern had no `u` flag, so nothing
// above U+FFFF could ever match — the Unicode TAG block (U+E0000–E007F), the best-known channel
// for hiding text that renders as nothing (a name that reads "Dana" and carries a hidden
// instruction for whoever, or whatever, later reads the owner's email or the CSV), passed
// straight through into the table, the owner notice and the export. Also missed: the deprecated
// format controls U+2065 / U+206A–206F, the Mongolian free variation selectors U+180B–180D, and
// the interlinear annotation marks U+FFF9–FFFB. Variation selectors U+FE00–FE0F (emoji) and the
// ideographic ones U+E0100–E01EF (real Japanese names) are deliberately kept.
const INVISIBLE_CHARS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/gu
const cleanText = (s) => s.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim()
const text = (max, { min = 0 } = {}) =>
  z.string().transform(cleanText).pipe(z.string().min(min).max(max))
// A required name/company must contain at least one letter or digit — "-",
// "..." and emoji-only values are not a name.
const hasSubstance = (s) => /[\p{L}\p{N}]/u.test(s)
const required = (max) => text(max, { min: 1 }).refine(hasSubstance, { message: 'Enter a real value.' })
// Free-text notes keep their line breaks; only the dangerous characters go.
// eslint-disable-next-line no-control-regex
const cleanNotes = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(INVISIBLE_CHARS, '').trim()

const schema = z.object({
  name:    required(100),
  company: required(200),
  // 254 is the practical maximum length of an email address (RFC 5321). It is
  // also what keeps the value under Postgres's btree index-row limit: the
  // unique index on lower(email) rejects a multi-KB string with a 500.
  email:   z.string().trim().toLowerCase().max(254).email(),
  // `roleCategory` is a taxonomy value from the current form, but older cached
  // clients sent a free-text job title here — resolveRole() below sorts out
  // which it is. `roleTitle` is the free-text job title.
  roleCategory: text(100).nullish(),
  roleTitle:    text(100).nullish(),
  // A value outside the whitelist (a stale cached client, a renamed form) is
  // dropped to the default below rather than rejecting the whole submission:
  // a mislabelled source is a reporting blemish, a lost lead is a lost lead.
  source:       z.unknown().transform(v => (typeof v === 'string' && LEAD_SOURCES.includes(v)) ? v : undefined),
  // Which candidate's verification page the form was on. Attribution only —
  // validated against the SAME code-shape check lib/verification.js uses for
  // the public /v/:code route itself (SHORT_CODE_CHARS/SHORT_CODE_LENGTH),
  // rather than a second, hand-rolled regex that could silently drift from
  // it. A bad value is dropped below rather than failing the whole
  // submission — attribution is a nice-to-have, not a required field.
  verificationCode: z.string().max(32).nullish(),
  // Honeypot: hidden from humans, irresistible to form-filling bots.
  website: z.string().nullish(),
  // Independent audit round 7: the forms now send the honeypot as `trap` under an unremarkable
  // field name. A field called "website" is exactly what password managers and browser autofill
  // fill in on a person's behalf — and a tripped honeypot answers "success" and stores nothing,
  // so an autofilled real employer's lead vanished without trace. `website` is still honoured for
  // cached older clients.
  trap: z.string().nullish(),
  // Cloudflare Turnstile response token (see lib/turnstile.js). Only required
  // when the deployment has TURNSTILE_SECRET_KEY set.
  turnstileToken: z.string().max(2048).nullish()
})

function resolveRole(data) {
  const raw = data.roleCategory || ''
  // AUDIT FIX (Section 9/10 pass): trims before normalizing, matching
  // migration 0032's one-time SQL cleanup (`btrim(role_title)` before its
  // own equivalent regexp_replace). Without the trim, a taxonomy value sent
  // with leading/trailing whitespace (" Sales ") normalized to "_sales_" —
  // one character off from every entry in ROLE_CATEGORIES — and silently
  // fell through to the "not a taxonomy value" branch below instead of
  // matching. Every reachable UI path sends this from a fixed <select>
  // today, so this was likely unreachable in practice, but the SQL
  // migration this function is supposed to mirror was already more
  // defensive than the code it was modeled on.
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (ROLE_CATEGORIES.includes(key))
    return { role_category: key, role_title: data.roleTitle || null }
  // Not a taxonomy value: an older client sending a job title in this field.
  return { role_category: null, role_title: data.roleTitle || raw || null }
}

// ── Owner notification + acknowledgement ────────────────────────────────────
// A new lead used to be announced through sendOwnerAlert(), which also writes
// alert_logs — the critical-failure feed. That buried real incidents and
// copied lead PII into a table with no delete path (migration 0023 removes the
// old rows). Leads now use their own email-only notice.
//
// Sent via waitUntil so the public form doesn't wait on Resend (and so a slow
// mail provider can't hang it, and "new" vs "already known" can't be told apart
// by response time). A per-hour budget stops a flood of fake leads from
// flooding the owner's inbox; the leads are still stored and counted in the
// admin list either way.
//
// The submitter gets an acknowledgement that doubles as the address
// confirmation: a signed "confirm" link (proof the inbox is theirs) and a
// signed one-click "remove me" link. The form is public, so the recipient can
// be anyone — hence: sent for a brand-new lead, and again only when an
// UNCONFIRMED lead resubmits (a person who never saw the first one); a
// per-recipient monthly cap in email.service.js; and its own hourly budget
// here. A confirmed lead's resubmission never re-sends anything.
const NOTICE_BUDGET_PER_HOUR = 20
const ACK_BUDGET_PER_HOUR = 30
const RESUBMIT_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000
// BUG FIX (fresh audit pass 2, Section 5): an unconfirmed lead's resubmission used to
// re-send the acknowledgement immediately, so a double-click (or two quick tries)
// spent BOTH of the address's monthly acknowledgement slots within seconds. A person
// who never saw the first email isn't helped by a second one a minute later.
const ACK_RESEND_COOLDOWN_MS = 10 * 60 * 1000

// BUG FIX (fresh audit pass, Section 5): the slot used to be spent the
// instant a send was ATTEMPTED, never given back if the send then actually
// failed (a Resend outage, a network blip). That meant a provider hiccup
// during real traffic silently burned through the whole hourly budget with
// zero emails delivered, then kept legitimate new leads from ever notifying
// the owner for the rest of that hour — even after Resend recovered. Mirrors
// the `refund` pattern rateLimiter.js's anonScan limiter already uses for
// exactly this reason (a failed attempt must not cost a budget meant to
// bound ATTEMPTS, not outcomes) — bounded per hour so a provider that is
// failing DURING an actual lead flood can't turn the budget into unlimited
// retries.
const NOTICE_MAX_REFUNDS_PER_HOUR = 10
const ACK_MAX_REFUNDS_PER_HOUR = 15

// BUG FIX (independent audit round 6, Section 5): this budget used to be a hand-rolled
// get-then-put against RATE_LIMIT_KV. KV is the wrong primitive for counting (see
// lib/rateLimitCore.js and wrangler.toml): parallel requests all read the same count, and KV
// rejects a second write to one key within a second — which the old code treated as an outage
// and failed OPEN on. Under a burst of fake leads (exactly what the budget exists for) nearly
// every increment was lost: 200 concurrent submissions against a limit of 20 sent 200 notices.
// It now goes through the same atomic Durable Object limiter every other quota in the app uses
// (hitQuota / refundQuota), including its bounded-refund rule. Still fails open if the limiter
// backend is down — a lost lead notice is the worse failure.
const BUDGET_WINDOW_SECONDS = 60 * 60

// Returns { allowed, refund }. `refund` hands back the slot this call just consumed if the send
// it was reserved for turns out to have failed.
async function withinBudget(env, name, max, maxRefunds) {
  const noRefund = async () => {}
  const key = `rl:${name}:budget`
  if (!(await hitQuota(env, key, max, BUDGET_WINDOW_SECONDS))) return { allowed: false, refund: noRefund }
  return { allowed: true, refund: () => refundQuota(env, key, BUDGET_WINDOW_SECONDS, maxRefunds) }
}

async function sendNotice(env, subject, message) {
  const budget = await withinBudget(env, 'leadnotice', NOTICE_BUDGET_PER_HOUR, NOTICE_MAX_REFUNDS_PER_HOUR)
  if (!budget.allowed) {
    console.warn(`Employer-lead notice budget (${NOTICE_BUDGET_PER_HOUR}/h) exhausted — skipped: ${subject}`)
    return false
  }
  try {
    // sendOwnerNotice answers false (it does not throw) when no owner inbox is configured.
    return (await emailService.sendOwnerNotice(env, subject, message)) !== false
  } catch (err) {
    console.error('Employer-lead notice failed:', err.message)
    await budget.refund()
    return false
  }
}

// Best-effort bookkeeping on a lead row: a failure (or a database that has not run migration
// 0054 yet) is logged and swallowed — it must never fail the submission or the send it follows.
// Deliberately does NOT touch updated_at: that column is mergeIntoExistingLead's concurrency token.
async function stampLead(env, match, patch) {
  try {
    let q = getSupabase(env).from('employer_leads').update(patch)
    q = match.id ? q.eq('id', match.id) : q.eq('email', match.email)
    const { error } = await q
    if (error) console.error('employer-leads: could not record', Object.keys(patch).join(', '), '-', error.message)
  } catch (err) {
    console.error('employer-leads: could not record', Object.keys(patch).join(', '), '-', err.message)
  }
}

const fieldLabel = (cat) => cat ? cat.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) : ''

// The two links every acknowledgement carries. Built here (not in the email
// service) because signing needs the secret and the frontend origin.
// Fresh audit pass 2 (G4): also builds the RFC 8058 one-click URL — the API's own
// origin, taken from the request that triggered the send (or API_ORIGIN when set),
// since the Worker has no other way to know its public hostname. Without an origin
// (e.g. a cron path) the acknowledgement simply goes out without the header.
function apiOrigin(c) {
  const fixed = c.env && c.env.API_ORIGIN
  if (fixed) return String(fixed).replace(/\/+$/, '')
  try { return new URL(c.req.url).origin } catch (_) { return null }
}

async function leadLinks(env, email, origin = null) {
  const [confirmTok, removeTok] = await Promise.all([
    signLeadToken(leadLinkSecrets(env).sign, 'confirm', email),
    signLeadToken(leadLinkSecrets(env).sign, 'remove', email)
  ])
  return {
    confirmUrl: `${env.FRONTEND_URL}/employer/confirm?token=${confirmTok}`,
    removeUrl:  `${env.FRONTEND_URL}/employer/remove?token=${removeTok}`,
    unsubscribeUrl: origin ? `${origin}/api/employer-leads/unsubscribe?token=${removeTok}` : null
  }
}

// Returns true only when the email actually went out.
//
// BUG FIX (fresh audit pass, Section 5): a send that came back `false` — a
// real Resend failure, OR the recipient's own per-address monthly cap
// (email.service.js's RECIPIENT_LIMITS) — used to leave the hourly ack slot
// spent either way. Refunding on any unsuccessful send (not just a thrown
// error) closes the Resend-outage gap the same way sendNotice's fix does; it
// is deliberately just as generous for the per-recipient-cap case, since
// that address is independently and correctly blocked regardless of this
// budget, refunding it here only frees the slot back up for a genuinely new
// lead rather than costing anyone an email they shouldn't have gotten.
async function sendAck(env, row, { skipBudget = false, origin = null } = {}) {
  let refund = async () => {}
  if (!skipBudget) {
    const budget = await withinBudget(env, 'leadack', ACK_BUDGET_PER_HOUR, ACK_MAX_REFUNDS_PER_HOUR)
    if (!budget.allowed) {
      console.warn(`Employer-lead acknowledgement budget (${ACK_BUDGET_PER_HOUR}/h) exhausted — skipped`)
      return false
    }
    refund = budget.refund
  }
  try {
    const sent = await emailService.sendEmployerLeadAck(
      env, getSupabase(env), row.email, row.name, fieldLabel(row.role_category), await leadLinks(env, row.email, origin))
    if (!sent) await refund()
    else await stampLead(env, { email: row.email }, { last_ack_at: new Date().toISOString() })
    return sent
  } catch (err) {
    console.error('Employer-lead acknowledgement failed:', err.message)
    await refund()
    return false
  }
}

async function runInBackground(c, task) {
  try { c.executionCtx.waitUntil(task) } catch (_) { await task }
}

async function notifyOwner(c, subject, message) {
  await runInBackground(c, sendNotice(c.env, subject, message))
}

const describeLead = (row) =>
  `name: ${row.name}\ncompany: ${row.company}\nemail: ${row.email}\n` +
  `field: ${row.role_category || '(none)'}\nrole: ${row.role_title || '(none)'}\n` +
  `source: ${row.source}${row.source_code ? ` (/v/${row.source_code})` : ''}`

// Everything that follows a lead being stored for the first time.
async function announceNewLead(c, row) {
  await notifyOwner(c, 'New employer lead', describeLead(row))
  await runInBackground(c, sendAck(c.env, row, { origin: apiOrigin(c) }))
}

const ok = (c) => c.json({ success: true, message: "We'll be in touch." })

// An address that used its "remove me" link is never re-added by the public
// form (see removeLead). The address is stored only as a SHA-256 hash.
//
// Deploy-order safety: if the migration that creates the table (0034) has not
// run yet, capturing the lead matters more than honouring a list that cannot
// exist yet — log it loudly and carry on rather than 500 the public form.
const MISSING_RELATION = ['42P01', 'PGRST205']
async function isSuppressed(supabase, email) {
  const { data, error } = await supabase
    .from('employer_lead_suppressions').select('email_hash').eq('email_hash', await sha256(email)).maybeSingle()
  if (error) {
    if (MISSING_RELATION.includes(error.code)) {
      console.error('employer_lead_suppressions does not exist — run migration 0034. Treating the address as not suppressed.')
      return false
    }
    throw error
  }
  return !!data
}

// POST /api/employer-leads — public, rate-limited.
//
// Resubmissions (same email) never rewrite what's already on the lead: the
// endpoint is unauthenticated, so letting a repeat submission overwrite
// name/company/role would let anyone who knows an employer's address rewrite
// that lead — and it used to wipe role_category whenever the optional field
// was left blank. A repeat only fills fields that are still empty, and is
// recorded (count + timestamp) so the admin list can show the lead is
// re-engaged. Status stays admin-owned.
// Applies a resubmission onto a lead that already exists for this email.
// Never overwrites name/company/role that are already set (see createLead's
// comment above the schema) — only fills gaps, bumps the engagement
// counters, and re-sends what an unconfirmed submitter needs.
//
// The update is guarded by `.eq('updated_at', existing.updated_at)` —
// optimistic concurrency on a column every write path in this file already
// keeps current. That does two things at once: it detects "deleted after we
// read it" (0 rows match, same as a delete would give), AND it detects
// "someone else — another concurrent resubmission, or an admin edit — wrote
// to this row after we read it" as the same case, since either changes
// updated_at out from under us. Both return 'retry' rather than one of them
// silently going through, so the caller re-reads the row's actual current
// state and redoes the whole decision (submission_count, and specifically
// the 24h resubmission-notice cooldown below) against fresh data instead of
// a snapshot that a second concurrent request could otherwise act on too —
// which used to let two resubmissions arriving together each independently
// pass the cooldown and both announce the same resubmission to the owner.
async function mergeIntoExistingLead(c, supabase, existing, row) {
  const now = new Date()
  const patch = {
    submission_count:  (existing.submission_count || 1) + 1,
    last_submitted_at: now.toISOString(),
    updated_at:        now.toISOString()
  }
  if (!existing.role_category && row.role_category) patch.role_category = row.role_category
  if (!existing.role_title    && row.role_title)    patch.role_title    = row.role_title
  if (!existing.source_code   && row.source_code)   patch.source_code   = row.source_code

  const { data: updated, error: updErr } = await supabase
    .from('employer_leads').update(patch)
    .eq('id', existing.id).eq('updated_at', existing.updated_at)
    .select('id').maybeSingle()
  if (updErr) throw updErr
  if (!updated) return 'retry'

  // BUG FIX (independent audit round 6, Section 5): both cooldowns below used to be measured
  // from last_submitted_at — which THIS very function resets on every resubmission. A person
  // retrying every few minutes because the first email never arrived kept that clock from ever
  // expiring and was never sent a second one (and the owner's "resubmitted" notice could never
  // fire for a lead that keeps coming back). They now run from when the email / notice actually
  // went out (last_ack_at / last_notice_at, migration 0054), falling back to created_at — the
  // moment the first of each was attempted — for rows that predate the columns.
  const sinceMs = (...stamps) => { const v = stamps.find(Boolean); const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? 0 : t }
  const lastAckMs = sinceMs(existing.last_ack_at, existing.created_at)
  const lastNoticeMs = sinceMs(existing.last_notice_at, existing.created_at)

  // Never confirmed and not dismissed: they may simply not have seen the first
  // email, so send it again (capped per recipient in email.service.js).
  if (!existing.confirmed_at && existing.status !== 'ARCHIVED' && now.getTime() - lastAckMs > ACK_RESEND_COOLDOWN_MS)
    await runInBackground(c, sendAck(c.env, existing, { origin: apiOrigin(c) }))

  // Worth a heads-up only if it's not a lead the admin dismissed and hasn't
  // already been announced recently (a hiring manager clicking twice isn't news).
  if (existing.status !== 'ARCHIVED' && now.getTime() - lastNoticeMs > RESUBMIT_NOTICE_COOLDOWN_MS) {
    const changed = ['name', 'company'].filter(k => existing[k] !== row[k]).map(k => `${k}: ${row[k]}`)
    const message = `${describeLead(existing)}\nsubmissions: ${patch.submission_count}` +
      (changed.length ? `\n\nThis time they entered different details (not saved over the lead):\n${changed.join('\n')}` : '')
    // Stamped only if the notice really went out, so a skipped (budget) or failed one is retried
    // by the next resubmission rather than silenced for a day.
    await runInBackground(c, (async () => {
      if (await sendNotice(c.env, 'Employer lead resubmitted', message))
        await stampLead(c.env, { id: existing.id }, { last_notice_at: now.toISOString() })
    })())
  }
  return 'ok'
}

async function createLead(c) {
  const body = await c.req.json()
  const data = schema.parse(body)
  if (data.website || data.trap) return ok(c)   // honeypot tripped: pretend success, store nothing

  // Fresh audit pass 2 (G5): bot challenge, active only when TURNSTILE_SECRET_KEY is
  // configured. Unlike the honeypot this answers with a REAL error: a person whose
  // widget failed to load or expired must be told to retry, not shown a success
  // message for something that was never stored.
  const human = await verifyTurnstile(c.env, data.turnstileToken, clientIp(c))
  if (!human) return c.json({ success: false, code: 'CAPTCHA_FAILED', message: 'We couldn\u2019t verify that you\u2019re human. Please try again.' }, 400)

  const supabase = getSupabase(c.env)
  // Asked to be removed: pretend success, store and send nothing (same
  // response as any other submission, so the form reveals nothing).
  if (await isSuppressed(supabase, data.email)) return ok(c)
  const row = {
    name:    data.name,
    company: data.company,
    email:   data.email,
    ...resolveRole(data),
    source:  data.source || 'verification_page',
    // Column is source_code (not verification_code — that name already means
    // a SCAN's own badge code on this same table's neighbor `scans`;
    // reusing it here would be an easy mapper mix-up later).
    source_code: (() => {
      const norm = normalizeCode(data.verificationCode)
      return isPlausibleCode(norm) ? norm : null
    })()
  }

  // BUG FIX (fresh audit pass, Section 5): this used to give up after a
  // SECOND collision on the same email — a race no rarer than the first one
  // it already handled (an admin deleting the row, or two submissions for
  // the same address landing together) — and just answered success having
  // stored and sent nothing. That silently dropped a real submission, which
  // is exactly the "a lost lead is a lost lead" outcome this endpoint's own
  // design (see the source_code comment above, and isSuppressed's own
  // deploy-order comment) says must never happen. Retried, bounded: each
  // pass re-derives what to do from the database's actual current state —
  // insert if the email is free, merge if it's already a lead — rather than
  // ever falling back to "pretend it worked".
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error: insertErr } = await supabase.from('employer_leads').insert(row)
    if (!insertErr) {
      await announceNewLead(c, row)
      return ok(c)
    }
    if (insertErr.code !== '23505') throw insertErr

    // Already a lead — or was, a moment ago.
    const { data: existing, error: selErr } = await supabase
      .from('employer_leads').select('*').eq('email', row.email).maybeSingle()
    if (selErr) throw selErr
    if (!existing) continue   // deleted between our insert attempt and this read — go again

    if (await mergeIntoExistingLead(c, supabase, existing, row) === 'ok') return ok(c)
    // 'retry': the row changed (or vanished) between our read and our
    // update above — go again with a fresh read rather than dropping it.
  }
  // Every attempt raced (a very sustained, unlikely collision): the address
  // is a real lead right now either way — nothing was lost, we just never
  // won a clean read/write pair on it inside the attempts we gave it. The
  // public form never reveals internal state either way.
  return ok(c)
}

// ── Admin: list / export ────────────────────────────────────────────────────

// Strips everything that has meaning inside a PostgREST `.or()` filter string:
// commas/parens/quotes break the filter, `%` and `*` are wildcards, `\` is the
// ilike escape. `_` is deliberately NOT stripped: it is a single-character
// wildcard in ilike, so it can only widen a match, and stripping it made a
// search for an address like "john_doe@corp.com" find nothing at all.
function sanitizeSearchTerm(term) {
  return String(term || '').replace(/[,()"%\\*]/g, '').trim().slice(0, 100)
}

// `field=none` selects leads with no category (the ones an admin still has to
// categorise by hand); otherwise a taxonomy key.
const FIELD_FILTERS = [...ROLE_CATEGORIES, 'none']

// Fresh audit pass 2 (G2): `status=OPEN` means NEW or CONTACTED — the same set
// open_lead_counts() tallies for the owner digest, so the digest's link opens a
// list whose size matches the number in the email.
const OPEN_STATUSES = ['NEW', 'CONTACTED']
// FEATURE GAP CLOSED (fresh audit pass, Section 5): `source`/`source_code`
// were captured meticulously (see the schema comments above) and reached the
// CSV export, but there was no way to filter or count by source anywhere in
// the live admin list — the reporting half of the feature was never
// finished. LEAD_SOURCES itself stays the narrower submitter-facing
// whitelist (only values a public form may claim); ALL_LEAD_SOURCES adds
// 'manual' (adminCreateLead's own source value) since an admin browsing or
// counting leads needs to be able to select every source that actually
// exists in the table, not just the ones a stranger could have typed.
const ALL_LEAD_SOURCES = [...LEAD_SOURCES, 'manual']

function parseFilters(c) {
  const status = c.req.query('status')
  const field  = c.req.query('field')
  const source = c.req.query('source')
  const sort   = c.req.query('sort') === 'activity' ? 'activity' : 'created'
  return {
    search: sanitizeSearchTerm(c.req.query('search')),
    status: LEAD_STATUSES.includes(status) || status === 'OPEN' ? status : null,
    field:  FIELD_FILTERS.includes(field) ? field : null,
    source: ALL_LEAD_SOURCES.includes(source) ? source : null,
    // yes = the address was confirmed, no = still unconfirmed.
    confirmed: ['yes', 'no'].includes(c.req.query('confirmed')) ? c.req.query('confirmed') : null,
    sort
  }
}

function applyFilters(query, { search, status, field, source, confirmed }) {
  // Fresh audit pass 2 (G7): also matches the verification page code a lead came
  // from and the admin's own notes — both were visible in the UI but unsearchable.
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,role_title.ilike.%${search}%,source_code.ilike.%${search}%,notes.ilike.%${search}%`)
  if (status === 'OPEN') query = query.in('status', OPEN_STATUSES)
  else if (status) query = query.eq('status', status)
  if (field === 'none') query = query.is('role_category', null)
  else if (field) query = query.eq('role_category', field)
  if (source) query = query.eq('source', source)
  if (confirmed === 'yes') query = query.not('confirmed_at', 'is', null)
  else if (confirmed === 'no') query = query.is('confirmed_at', null)
  return query
}

// `id` is the tiebreaker: created_at / last_submitted_at are not unique (a
// bulk import or one transaction stamps many rows identically), and without a
// total order a row on a page boundary can appear on two pages or none —
// which in the chunked CSV export means a duplicated or missing lead.
function applySort(query, sort) {
  return (sort === 'activity'
    ? query.order('last_submitted_at', { ascending: false }).order('created_at', { ascending: false })
    : query.order('created_at', { ascending: false })
  ).order('id', { ascending: false })
}

// Keyset cursor for the chunked CSV export (see adminExportLeads). applySort's
// own id-tiebreak comment above is about a single, static read — it doesn't
// help across MANY sequential requests. An offset-based page (fine for the
// admin list's one-shot read) re-evaluates the whole filtered/sorted result on
// every request: a lead deleted from earlier in the order shifts every later
// row up by one position, so the next offset-based chunk starts one row too
// late and silently drops a lead that was never exported. A keyset cursor —
// "give me rows that sort strictly after the last one I already have" — has
// no notion of position, so a deletion anywhere in the result set can't shift
// it. `sort` must be one of applySort's own two orderings; the tuple shape
// mirrors whichever one is in use.
function applyCursor(query, sort, cursor) {
  if (!cursor) return query
  if (sort === 'activity') {
    const [lastSubmittedAt, createdAt, id] = cursor
    return query.or(
      `last_submitted_at.lt.${lastSubmittedAt},` +
      `and(last_submitted_at.eq.${lastSubmittedAt},created_at.lt.${createdAt}),` +
      `and(last_submitted_at.eq.${lastSubmittedAt},created_at.eq.${createdAt},id.lt.${id})`
    )
  }
  const [createdAt, id] = cursor
  return query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
}

// The cursor tuple for a row, matching applyCursor's shape for the given sort.
function cursorFor(row, sort) {
  return sort === 'activity'
    ? [row.last_submitted_at, row.created_at, row.id]
    : [row.created_at, row.id]
}

function pageParams(c, defaultSize = 25, maxSize = 100) {
  const page     = Math.max(1, parseInt(c.req.query('page'), 10) || 1)
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(c.req.query('pageSize'), 10) || defaultSize))
  return { page, pageSize, from: (page - 1) * pageSize, to: (page - 1) * pageSize + pageSize - 1 }
}

// GET /api/employer-leads — admin only. Paginated like every other admin list
// (it used to return everything in one response, which Supabase silently caps
// at its row limit — older leads would just vanish from the list).
async function adminListLeads(c) {
  const supabase = getSupabase(c.env)
  const filters = parseFilters(c)
  const { page, pageSize, from, to } = pageParams(c)

  let { data, error, count } = await applySort(
    applyFilters(supabase.from('employer_leads').select('*', { count: 'exact' }), filters), filters.sort
  ).range(from, to)
  if (isRangeError(error)) {
    // A page past the end (rows deleted since the client last looked, a stale
    // bookmark): an empty page that still reports the real total, so the UI
    // can step back to the last real page instead of showing an error.
    const head = await applyFilters(supabase.from('employer_leads').select('id', { count: 'exact', head: true }), filters)
    if (head.error) throw head.error
    data = []; count = head.count; error = null
  }
  if (error) throw error

  // Per-status totals for the filter chips (unaffected by the search box or
  // the status filter itself, so the chips always show the whole picture).
  const counts = {}
  await Promise.all(LEAD_STATUSES.map(async (s) => {
    const { count: n, error: cErr } = await supabase
      .from('employer_leads').select('id', { count: 'exact', head: true }).eq('status', s)
    if (cErr) throw cErr
    counts[s] = n || 0
  }))
  counts.OPEN = OPEN_STATUSES.reduce((sum, s) => sum + (counts[s] || 0), 0)

  // FEATURE GAP CLOSED (fresh audit pass, Section 5): same shape as `counts`
  // above, but by source — same "unaffected by the current filters" reasoning,
  // so the breakdown always reflects the whole table, not just what's on screen.
  const sourceCounts = {}
  await Promise.all(ALL_LEAD_SOURCES.map(async (s) => {
    const { count: n, error: cErr } = await supabase
      .from('employer_leads').select('id', { count: 'exact', head: true }).eq('source', s)
    if (cErr) throw cErr
    sourceCounts[s] = n || 0
  }))

  // How many leads still have an unconfirmed address (also unaffected by the
  // current filters) — the number worth acting on before anyone is emailed.
  // Optional garnish like the supply figure: a deployment that has not run
  // migration 0034 yet must still get its list.
  const { count: unconfirmed, error: uErr } = await supabase
    .from('employer_leads').select('id', { count: 'exact', head: true }).is('confirmed_at', null)
  if (uErr) console.error('employer-leads: could not count unconfirmed leads:', uErr.message)

  // FEATURE GAP CLOSED (fresh audit pass, Section 5): total size of the
  // do-not-contact list. Same "optional garnish" posture as `unconfirmed` —
  // a deployment that hasn't run migration 0034 yet must still get its list.
  let suppressed = null
  const { count: suppressedCount, error: sErr } = await supabase
    .from('employer_lead_suppressions').select('email_hash', { count: 'exact', head: true })
  if (sErr && !MISSING_RELATION.includes(sErr.code)) console.error('employer-leads: could not count suppressions:', sErr.message)
  else if (!sErr) suppressed = suppressedCount || 0

  // Verified-candidate supply per field. Optional garnish: if the migration
  // that defines it hasn't run, the list must still load.
  let supply = null
  try {
    const { data: rows, error: sErr } = await supabase.rpc('verified_candidate_counts', { p_min_score: constants.ATS_BADGE_THRESHOLD })
    if (!sErr && Array.isArray(rows))
      supply = Object.fromEntries(rows.map(r => [r.role_category, Number(r.candidate_count)]))
  } catch (_) { supply = null }

  return c.json({ success: true, data: (data || []).map(leadRowToCamel),
    meta: { page, pageSize, total: count || 0, counts, sourceCounts, unconfirmed: uErr ? null : (unconfirmed || 0), suppressed, candidateSupply: supply } })
}

// CSV cells are always quoted, and any cell that starts with a character a
// spreadsheet would treat as a formula is defused — lead fields are typed by
// strangers, and this file gets opened in Excel.
function csvCell(value) {
  let s = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

const CSV_COLUMNS = [
  ['Name', r => r.name], ['Company', r => r.company], ['Email', r => r.email],
  ['Field', r => r.role_category], ['Role title', r => r.role_title],
  ['Source', r => r.source], ['Verification page', r => r.source_code],
  ['Status', r => r.status], ['Notes', r => r.notes],
  ['Submissions', r => r.submission_count], ['First received', r => r.created_at],
  ['Last submitted', r => r.last_submitted_at], ['Contacted at', r => r.contacted_at],
  ['Email confirmed at', r => r.confirmed_at]
]
const EXPORT_CHUNK = 1000
const EXPORT_MAX_ROWS = 50_000
// Excel only reads a .csv as UTF-8 when it starts with a byte-order mark;
// without it a name like "José" or "Wanjiru Mwangi-Müller" opens as mojibake.
const CSV_BOM = '\uFEFF'

// GET /api/employer-leads/export.csv — admin only. Honors the same search /
// status / field / sort as the list, and is chunked so the row cap on a single
// PostgREST response can't truncate it.
async function adminExportLeads(c) {
  const supabase = getSupabase(c.env)
  const filters = parseFilters(c)
  const rows = []
  let cursor = null
  // Asks for ONE row past the cap so "exactly at the cap" and "more than the cap" can be told apart.
  let truncated = false
  for (;;) {
    const want = Math.min(EXPORT_CHUNK, EXPORT_MAX_ROWS + 1 - rows.length)
    const { data, error } = await applyCursor(
      applySort(applyFilters(supabase.from('employer_leads').select('*'), filters), filters.sort),
      filters.sort, cursor
    ).limit(want)
    if (error) throw error
    if (!data.length) break
    rows.push(...data)
    if (rows.length > EXPORT_MAX_ROWS) { rows.length = EXPORT_MAX_ROWS; truncated = true; break }
    if (data.length < want) break
    cursor = cursorFor(data[data.length - 1], filters.sort)
  }
  // FEATURE GAP CLOSED (independent audit round 6, Section 5): a capped export used to be
  // flagged only by a console.warn — the admin got a file that looked complete and wasn't.
  // The response now says so (X-Export-Truncated, exposed to the SPA via middleware/cors.js).
  if (truncated) console.warn(`Employer-lead export hit the ${EXPORT_MAX_ROWS}-row cap — the file is truncated`)
  // Exporting every lead's name and email is exactly what an audit trail is for.
  await logAdminAction(c, supabase, 'lead.export', 'employer_leads', null, {
    rows: rows.length,
    truncated,
    filters: Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && k !== 'search')),
    searched: !!filters.search
  })
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')]
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','))
  return c.body(CSV_BOM + lines.join('\r\n') + '\r\n', 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="employer-leads.csv"',
    'X-Export-Rows': String(rows.length),
    'X-Export-Truncated': truncated ? 'true' : 'false'
  })
}

// ── Admin: create / update / bulk / delete ──────────────────────────────────

// POST /api/employer-leads/manual — admin only. A lead met at a conference or
// forwarded by a candidate never comes through the public form; without this
// it lived in a spreadsheet, outside the matching and follow-up tooling.
// Stored exactly like a public lead (same cleaning, same unique email) but
// with source 'manual', and no owner notice or acknowledgement — the admin
// who typed it in obviously already knows.
const manualSchema = z.object({
  name:    required(100),
  company: required(200),
  email:   z.string().trim().toLowerCase().max(254).email(),
  roleCategory: z.enum(ROLE_CATEGORIES).nullish(),
  roleTitle:    text(100).nullish(),
  notes:        z.string().max(2000).transform(cleanNotes).nullish(),
  status:       z.enum(LEAD_STATUSES).optional(),
  // An address that used its "remove me" link is refused unless the admin
  // says the person has since asked to be added (see adminCreateLead).
  overrideRemoval: z.boolean().optional()
})

async function adminCreateLead(c) {
  const d = manualSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const now = new Date().toISOString()
  const row = {
    name: d.name, company: d.company, email: d.email,
    role_category: d.roleCategory || null, role_title: d.roleTitle || null,
    notes: d.notes || null, status: d.status || 'NEW', source: 'manual',
    contacted_at: CONTACTED_STATUSES.includes(d.status) ? now : null,
    // Typed in by an admin from a conversation they had — not a stranger's
    // claim to an inbox — so there is nothing left to confirm.
    confirmed_at: now
  }

  const suppressed = await isSuppressed(supabase, d.email)
  if (suppressed && !d.overrideRemoval)
    return c.json({
      success: false, code: 'REMOVAL_REQUESTED',
      message: 'This address asked to be removed and is on the do-not-contact list. Only add it again if they have since asked you to.'
    }, 409)

  // The suppression is lifted AFTER the insert (a failed insert must not silently undo someone's
  // removal request), so the lift has to be safe to RETRY. BUG FIX (independent audit round 6,
  // Section 5): if the lift failed, the lead already existed, the admin saw a 500, and every retry
  // hit the unique index and answered 409 before ever reaching the lift — leaving the address
  // suppressed for good (the public form silently ignoring it) next to a lead that exists. The
  // lift now also runs on the "already exists" answer when the admin said to override.
  const liftSuppression = async () => {
    const { error: liftErr } = await supabase.from('employer_lead_suppressions').delete().eq('email_hash', await sha256(d.email))
    if (liftErr) throw liftErr
  }
  const { data, error } = await supabase.from('employer_leads').insert(row).select().single()
  if (error) {
    if (error.code === '23505') {
      if (suppressed) {
        await liftSuppression()
        await logAdminAction(c, supabase, 'lead.suppression_lift', 'employer_lead_suppression', await sha256(d.email), { via: 'manual_add_retry' })
      }
      return c.json({ success: false, message: 'A lead with that email already exists.', ...(suppressed ? { suppressionLifted: true } : {}) }, 409)
    }
    throw error
  }
  // Explicitly re-added: lift the suppression so the public form and the
  // acknowledgement flow treat them like any other lead again.
  if (suppressed) await liftSuppression()
  await logAdminAction(c, supabase, 'lead.create', 'employer_lead', data.id, { liftedRemoval: !!suppressed })
  return c.json({ success: true, data: leadRowToCamel(data) }, 201)
}

const updateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes:  z.string().max(2000).transform(cleanNotes).optional(),
  // Correcting a typo, or categorising a lead that arrived without a field so
  // it can finally be matched against candidate supply. The email is not
  // editable: it is the identity the dedupe and the unique index key on.
  name:         required(100).optional(),
  company:      required(200).optional(),
  roleCategory: z.enum(ROLE_CATEGORIES).nullable().optional(),
  roleTitle:    text(100).nullable().optional()
}).refine(d => Object.values(d).some(v => v !== undefined), { message: 'Nothing to update.' })

// PATCH /api/employer-leads/:id — admin only. Any subset of the fields.
// contacted_at is stamped the first time a lead reaches CONTACTED (or CONVERTED).
async function adminUpdateLeadStatus(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const d = updateSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)

  const { data: existing, error: readErr } = await supabase
    .from('employer_leads').select('id, contacted_at').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!existing) return c.json({ success: false, message: 'Lead not found.' }, 404)

  const patch = { updated_at: new Date().toISOString() }
  if (d.status  !== undefined) patch.status  = d.status
  if (d.notes   !== undefined) patch.notes   = d.notes || null
  if (d.name    !== undefined) patch.name    = d.name
  if (d.company !== undefined) patch.company = d.company
  if (d.roleCategory !== undefined) patch.role_category = d.roleCategory
  if (d.roleTitle    !== undefined) patch.role_title    = d.roleTitle || null
  if (CONTACTED_STATUSES.includes(d.status) && !existing.contacted_at) patch.contacted_at = patch.updated_at

  const { data, error } = await supabase
    .from('employer_leads').update(patch).eq('id', id).select().maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)
  // Field NAMES and the status transition only — never the values typed.
  await logAdminAction(c, supabase, 'lead.update', 'employer_lead', id, {
    fields: Object.keys(d).filter(k => d[k] !== undefined),
    ...(d.status !== undefined ? { status: d.status } : {})
  })
  return c.json({ success: true, data: leadRowToCamel(data) })
}

// POST /api/employer-leads/bulk — admin only. Clearing a spam wave or marking
// a batch contacted was one request per row.
const BULK_MAX = 100
const bulkSchema = z.object({
  ids:    z.array(z.string().regex(UUID_RE, 'Invalid lead id.')).min(1).max(BULK_MAX),
  action: z.enum(['setStatus', 'delete']),
  status: z.enum(LEAD_STATUSES).optional()
}).refine(d => d.action !== 'setStatus' || d.status !== undefined, { message: 'status required for setStatus.' })

async function adminBulkUpdateLeads(c) {
  const { ids, action, status } = bulkSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)

  if (action === 'delete') {
    const { data, error } = await supabase.from('employer_leads').delete().in('id', ids).select('id')
    if (error) throw error
    await logAdminAction(c, supabase, 'lead.bulk_delete', 'employer_lead', null, { ids: (data || []).map(r => r.id) })
    return c.json({ success: true, affected: (data || []).length })
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('employer_leads').update({ status, updated_at: now }).in('id', ids).select('id')
  if (error) throw error
  // Two writes (status, then the first-contact stamp), so the second can fail after the first
  // landed. The status change is real either way and must reach the audit trail: it used to be
  // skipped when the stamp threw, leaving a bulk change nobody could later account for.
  let stampErr = null
  if (CONTACTED_STATUSES.includes(status)) {
    ;({ error: stampErr } = await supabase
      .from('employer_leads').update({ contacted_at: now }).in('id', ids).is('contacted_at', null))
  }
  await logAdminAction(c, supabase, 'lead.bulk_status', 'employer_lead', null,
    { status, ids: (data || []).map(r => r.id), ...(stampErr ? { contactedStampFailed: true } : {}) })
  if (stampErr) throw stampErr
  return c.json({ success: true, affected: (data || []).length })
}

// DELETE /api/employer-leads/:id — admin only. Lead data no longer exists
// anywhere else (notifications don't copy it into alert_logs any more), so
// this is a complete removal.
async function adminDeleteLead(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const supabase = getSupabase(c.env)
  const { data, error } = await supabase
    .from('employer_leads').delete().eq('id', id).select().maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)
  await logAdminAction(c, supabase, 'lead.delete', 'employer_lead', id)
  return c.json({ success: true, message: 'Lead deleted.' })
}

// ── Public: confirm / remove (the links in the acknowledgement email) ───────
// Both are POSTs, and the frontend only calls remove on a button press: mail
// scanners and link previewers follow GET links (and some run scripts), and an
// unsubscribe that fires on a preview would remove people who never asked.
// Neither reveals whether an address is (still) on the list beyond what the
// token holder — the inbox owner — already knows.
const tokenBodySchema = z.object({ token: z.string().min(10).max(700) })
const INVALID_LINK = { success: false, message: 'This link is not valid. Use the link from the most recent email we sent you.' }

// POST /api/employer-leads/confirm { token }
async function confirmLead(c) {
  const { token } = tokenBodySchema.parse(await c.req.json())
  const email = await verifyLeadToken(leadLinkSecrets(c.env).verify, 'confirm', token)
  if (!email) return c.json(INVALID_LINK, 400)

  const supabase = getSupabase(c.env)
  const { data: lead, error } = await supabase
    .from('employer_leads').select('*').eq('email', email).maybeSingle()
  if (error) throw error
  if (!lead) return c.json({ success: true, status: 'not_found', message: 'We no longer have a request for this address.' })
  if (lead.confirmed_at) return c.json({ success: true, status: 'already', message: 'This address is already confirmed.' })

  const now = new Date().toISOString()
  // BUG FIX (fresh audit pass, Section 5): the `.is('confirmed_at', null)`
  // guard is optimistic concurrency against a double-click or a mail client
  // retrying the POST — but the old code never checked whether the update
  // actually matched a row. The loser of that race updated 0 rows (no
  // error — Postgres doesn't treat "matched nothing" as one), and still
  // unconditionally called notifyOwner() right after, so the owner got the
  // same "Employer lead confirmed" email twice. `.select('id').maybeSingle()`
  // makes the outcome checkable, mirroring the same guard
  // mergeIntoExistingLead already uses for exactly this class of race.
  const { data: updated, error: updErr } = await supabase
    .from('employer_leads').update({ confirmed_at: now, updated_at: now })
    .eq('id', lead.id).is('confirmed_at', null).select('id').maybeSingle()
  if (updErr) throw updErr
  if (!updated) return c.json({ success: true, status: 'already', message: 'This address is already confirmed.' })
  // BUG FIX (fresh audit pass, Section 5 re-pass): notifyOwner used to fire
  // unconditionally here — including for a lead the admin already ARCHIVED
  // (dismissed as spam / not interested). mergeIntoExistingLead already
  // treats ARCHIVED as "don't bother the owner about this one again" for a
  // resubmission; confirming an address is the same category of event and
  // deserves the same treatment — a real employer confirming interest on a
  // lead that's still open is worth a heads-up, one the admin has already
  // dismissed is not.
  if (lead.status !== 'ARCHIVED') await notifyOwner(c, 'Employer lead confirmed', describeLead(lead))
  return c.json({ success: true, status: 'confirmed', message: "Thanks — your email is confirmed. We'll be in touch when there are Verified candidates in your field." })
}

// POST /api/employer-leads/remove { token }
// Records the do-not-contact hash FIRST, then deletes the lead: if the second
// step fails the caller retries and the operation is idempotent, whereas the
// other order could leave a deleted lead the public form re-creates.
async function removeLead(c) {
  const { token } = tokenBodySchema.parse(await c.req.json())
  const email = await verifyLeadToken(leadLinkSecrets(c.env).verify, 'remove', token)
  if (!email) return c.json(INVALID_LINK, 400)

  await performRemoval(getSupabase(c.env), email)
  return c.json({ success: true, message: "You've been removed. We won't contact you again." })
}

async function performRemoval(supabase, email) {
  const { error: supErr } = await supabase
    .from('employer_lead_suppressions').upsert({ email_hash: await sha256(email) }, { onConflict: 'email_hash', ignoreDuplicates: true })
  if (supErr) throw supErr
  const { error: delErr } = await supabase.from('employer_leads').delete().eq('email', email)
  if (delErr) throw delErr
}

// POST /api/employer-leads/unsubscribe?token=… — the RFC 8058 one-click target named in
// the acknowledgement's List-Unsubscribe header (fresh audit pass 2, G4). Mail clients
// (Gmail, Apple Mail, Outlook) POST `List-Unsubscribe=One-Click` here, with the token
// in the URL because the body is a form, not JSON, and is ignored. POST-only for the
// same reason removeLead is: a scanner or link previewer only ever GETs.
async function unsubscribeLead(c) {
  const token = c.req.query('token') || ''
  const email = token.length >= 10 && token.length <= 700 ? await verifyLeadToken(leadLinkSecrets(c.env).verify, 'remove', token) : null
  if (!email) return c.json(INVALID_LINK, 400)
  await performRemoval(getSupabase(c.env), email)
  return c.json({ success: true, message: "You've been removed. We won't contact you again." })
}

// GET /api/employer-leads/unsubscribe?token=… — what a mail client opens when it does NOT do
// RFC 8058 one-click (it only follows the List-Unsubscribe URL as a link). It used to answer a
// bare JSON 404, so the person trying to opt out landed on an error page. It never removes
// anything (a GET must not — scanners and previewers issue them): it sends the visitor to the
// remove page, which asks for a button press. It does not look at the token, so it reveals
// nothing about whether it is valid.
function unsubscribeRedirect(c) {
  const token = c.req.query('token') || ''
  const base = String((c.env && c.env.FRONTEND_URL) || '').replace(/\/+$/, '')
  const plausible = token.length >= 10 && token.length <= 700
  return c.redirect(`${base}/employer/remove${plausible ? `?token=${encodeURIComponent(token)}` : ''}`, 302)
}

// ── Admin: do-not-contact list ──────────────────────────────────────────────
// FEATURE GAP CLOSED (fresh audit pass, Section 5): the only way an admin
// could learn an address was suppressed used to be trying to re-add it via
// adminCreateLead and reading the 409. There was no way to check a specific
// address up front (e.g. answering a "why can't I sign up again" support
// email) or to lift a suppression without also recreating the lead right
// then. A browsable LIST of suppressions isn't meaningful here — only a
// SHA-256 hash is stored (see removeLead's comment above), so a list of rows
// would just be opaque hashes with no address to show next to them. What's
// actually useful instead: look up one known address, and lift it on its own.
const emailBodySchema = z.object({ email: z.string().trim().toLowerCase().max(254).email() })

// POST /api/employer-leads/suppressions/check { email } — admin only.
async function adminCheckSuppression(c) {
  const { email } = emailBodySchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase
    .from('employer_lead_suppressions').select('created_at').eq('email_hash', await sha256(email)).maybeSingle()
  if (error) throw error
  // Fresh audit pass 2 (G7): also says whether a lead exists for the address, so the
  // admin UI can warn before "add to do-not-contact" deletes it (that action removes
  // the lead along with recording the suppression).
  const { data: lead, error: leadErr } = await supabase
    .from('employer_leads').select('id').eq('email', email).maybeSingle()
  if (leadErr) throw leadErr
  return c.json({ success: true, data: { suppressed: !!data, since: data?.created_at || null, leadExists: !!lead } })
}

// POST /api/employer-leads/suppressions { email } — admin only.
// FEATURE GAP CLOSED (fresh audit pass, Section 5): the do-not-contact list
// could only ever be written by removeLead, which requires the person's own
// signed token from an email they received. Someone who asks to be removed
// through any other channel — a reply to the acknowledgement email, a phone
// call, a support ticket — had no equivalent: an admin's only lever was
// adminDeleteLead, which removes the lead row but records no suppression, so
// the same address could resubmit the public form (or be re-added manually)
// at any time afterwards. This is that missing write path. Same order and
// same effect as removeLead: the suppression hash is recorded FIRST, then any
// existing lead for that address is deleted, so a failure partway through is
// idempotent on retry rather than leaving a deleted lead the public form
// could recreate. Deliberately doesn't require a lead to already exist —
// pre-emptively blocking a known-bad address is a legitimate use on its own.
async function adminAddSuppression(c) {
  const { email } = emailBodySchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const hash = await sha256(email)
  const { error: supErr } = await supabase
    .from('employer_lead_suppressions').upsert({ email_hash: hash }, { onConflict: 'email_hash', ignoreDuplicates: true })
  if (supErr) throw supErr
  const { data: removed, error: delErr } = await supabase
    .from('employer_leads').delete().eq('email', email).select('id')
  if (delErr) throw delErr
  // target_id is the hash, not the address — same reasoning as
  // adminLiftSuppression's own audit entry below.
  await logAdminAction(c, supabase, 'lead.suppression_add', 'employer_lead_suppression', hash, {
    leadsRemoved: (removed || []).length
  })
  return c.json({
    success: true,
    message: (removed || []).length
      ? 'Address added to the do-not-contact list. Its existing lead was removed.'
      : 'Address added to the do-not-contact list.',
    data: { leadsRemoved: (removed || []).length }
  })
}

// DELETE /api/employer-leads/suppressions { email } — admin only. Lifts a
// suppression without recreating the lead (adminCreateLead's
// `overrideRemoval` does both at once, for the common "yes, add them back
// too" case; this is for "lift it, but they haven't asked to be re-added").
async function adminLiftSuppression(c) {
  const { email } = emailBodySchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const hash = await sha256(email)
  const { data, error } = await supabase
    .from('employer_lead_suppressions').delete().eq('email_hash', hash).select('email_hash').maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'That address is not on the do-not-contact list.' }, 404)
  // target_id is the hash, not the address — the audit trail may record
  // WHICH suppression was lifted without ever holding the address itself.
  await logAdminAction(c, supabase, 'lead.suppression_lift', 'employer_lead_suppression', hash)
  return c.json({ success: true, message: 'Suppression lifted. The address can be added or can resubmit again.' })
}

// POST /api/employer-leads/:id/request-confirmation — admin only. Leads that
// arrived before address confirmation existed have no confirm link in any
// email they hold; this sends them one. Goes through the same per-recipient
// cap as every acknowledgement, so it cannot be used to mail-bomb an address.
async function adminRequestConfirmation(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const supabase = getSupabase(c.env)
  const { data: lead, error } = await supabase.from('employer_leads').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  if (!lead) return c.json({ success: false, message: 'Lead not found.' }, 404)
  if (lead.confirmed_at) return c.json({ success: false, message: 'This address is already confirmed.' }, 409)

  const sent = await sendAck(c.env, lead, { skipBudget: true, origin: apiOrigin(c) })
  await logAdminAction(c, supabase, 'lead.request_confirmation', 'employer_lead', id, { sent })
  if (!sent) return c.json({ success: false, message: 'The email was not sent (this address has reached its email limit, or delivery failed). Try again later.' }, 429)
  return c.json({ success: true, message: 'Confirmation email sent.' })
}

// POST /api/employer-leads/:id/mark-confirmed — admin only (fresh audit pass 2, G1).
// For an employer who confirmed the address some other way — a reply to the email, a
// call. Until now the only options were to wait for a link click that was never coming or
// delete the lead and lose its notes and history. Same atomic guard as confirmLead, so
// it can't overwrite a confirmation that just landed; logged, because it records the
// admin's word rather than proof the inbox is the submitter's.
async function adminMarkConfirmed(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const supabase = getSupabase(c.env)
  const now = new Date().toISOString()
  const { data: updated, error } = await supabase
    .from('employer_leads').update({ confirmed_at: now, updated_at: now })
    .eq('id', id).is('confirmed_at', null).select('id').maybeSingle()
  if (error) throw error
  if (!updated) {
    const { data: lead, error: selErr } = await supabase.from('employer_leads').select('id').eq('id', id).maybeSingle()
    if (selErr) throw selErr
    if (!lead) return c.json({ success: false, message: 'Lead not found.' }, 404)
    return c.json({ success: false, message: 'This address is already confirmed.' }, 409)
  }
  await logAdminAction(c, supabase, 'lead.mark_confirmed', 'employer_lead', id)
  return c.json({ success: true, message: 'Marked as confirmed.', data: { confirmedAt: now } })
}

// POST /api/employer-leads/notify-candidates { field, dryRun? } — admin only.
// FEATURE GAP CLOSED (independent audit round 6, Section 5): both employer forms promise "we'll
// email you when there are Verified candidates in your field", but nothing could ever do it —
// the owner digest (lead-match.service.js) tells the OWNER, and the owner then had to write to
// each lead by hand. This is the admin's one-click follow-through.
//
// Deliberately an admin ACTION, not an automatic send: a person still decides when. It goes only
// to leads that are (a) in that field, (b) CONFIRMED — an unconfirmed address may be a stranger's
// typo or a bot — (c) still open (NEW or CONTACTED), and (d) not already told in the last 30 days
// (last_candidates_notified_at). It refuses when the field has no Verified candidates, mails at
// most NOTIFY_BATCH_MAX per call (the response says how many remain), names no candidate (only a
// count), and every email carries the signed one-click removal link and List-Unsubscribe header.
// A second per-recipient guard lives in email.service.js (1 per address per 30 days), so a
// double-click or two admins at once can never mail the same person twice. Each lead that was
// actually mailed is stamped, and a NEW one moves to CONTACTED (contacted_at set once).
// `dryRun` reports the counts without sending anything.
const NOTIFY_BATCH_MAX = 25
// How many eligible leads one call will LOOK at to find NOTIFY_BATCH_MAX it can actually mail.
// A lead that cannot be mailed (a mailbox the provider rejects, an address already at its
// per-recipient cap) is never stamped, so it stays eligible and sorts first on every call; with
// a batch of exactly 25, 25 such leads would have blocked everyone behind them for good.
const NOTIFY_EXAMINE_MAX = 100
const NOTIFY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
const notifySchema = z.object({ field: z.enum(ROLE_CATEGORIES), dryRun: z.boolean().optional() })
const MISSING_COLUMN = ['42703', 'PGRST204']

async function adminNotifyCandidates(c) {
  const { field, dryRun } = notifySchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)

  const { data: supplyRows, error: supplyErr } = await supabase.rpc('verified_candidate_counts', { p_min_score: constants.ATS_BADGE_THRESHOLD })
  if (supplyErr) throw supplyErr
  const candidates = Number((supplyRows || []).find(r => r.role_category === field)?.candidate_count) || 0
  if (!candidates)
    return c.json({ success: false, code: 'NO_CANDIDATES', message: `There are no Verified candidates in ${fieldLabel(field)} yet, so there is nothing to tell leads.` }, 409)

  const cutoff = new Date(Date.now() - NOTIFY_COOLDOWN_MS).toISOString()
  const eligible = () => supabase.from('employer_leads')
    .select('id, name, email, status, contacted_at', { count: 'exact' })
    .eq('role_category', field).not('confirmed_at', 'is', null).in('status', OPEN_STATUSES)
    .or(`last_candidates_notified_at.is.null,last_candidates_notified_at.lt.${cutoff}`)
  const { data: batch, error: selErr, count } = await eligible()
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(NOTIFY_EXAMINE_MAX)
  if (selErr) {
    if (MISSING_COLUMN.includes(selErr.code))
      return c.json({ success: false, message: 'Run migration 0054 before using this.' }, 409)
    throw selErr
  }
  const total = count || 0
  if (dryRun) return c.json({ success: true, data: { field, candidates, eligible: total, sent: 0, failed: 0, remaining: total, dryRun: true } })

  const origin = apiOrigin(c)
  let sent = 0, failed = 0, skipped = 0
  const sentIds = []
  for (const lead of batch || []) {
    if (sent >= NOTIFY_BATCH_MAX) break
    let ok = false
    try {
      // Re-checked right before each send: someone who clicked "remove" after this batch was
      // selected must not be emailed. (Their lead row is normally already gone; this covers the gap.)
      if (await isSuppressed(supabase, lead.email)) { skipped++; continue }
      const { removeUrl, unsubscribeUrl } = await leadLinks(c.env, lead.email, origin)
      ok = await emailService.sendEmployerCandidatesAvailable(
        c.env, supabase, lead.email, lead.name, fieldLabel(field), candidates, { removeUrl, unsubscribeUrl })
    } catch (err) {
      console.error('Employer-lead candidate notification failed:', err.message)
    }
    if (!ok) { failed++; continue }
    sent++; sentIds.push(lead.id)
    const stamp = new Date().toISOString()
    const patch = { last_candidates_notified_at: stamp, updated_at: stamp }
    if (lead.status === 'NEW') patch.status = 'CONTACTED'
    if (!lead.contacted_at) patch.contacted_at = stamp
    const { error: stampErr } = await supabase.from('employer_leads').update(patch).eq('id', lead.id)
    if (stampErr) console.error('Employer-lead candidate notification sent but not recorded:', stampErr.message)
  }
  await logAdminAction(c, supabase, 'lead.notify_candidates', 'employer_lead', null, { field, candidates, sent, failed, skipped, ids: sentIds })
  return c.json({ success: true, data: { field, candidates, eligible: total, sent, failed, skipped, remaining: Math.max(0, total - sent - skipped) } })
}

module.exports = {
  createLead, confirmLead, removeLead, unsubscribeLead, unsubscribeRedirect, adminMarkConfirmed,
  adminListLeads, adminExportLeads, adminCreateLead,
  adminUpdateLeadStatus, adminBulkUpdateLeads, adminDeleteLead, adminRequestConfirmation,
  adminCheckSuppression, adminAddSuppression, adminLiftSuppression, adminNotifyCandidates,
  LEAD_STATUSES, LEAD_SOURCES
}
