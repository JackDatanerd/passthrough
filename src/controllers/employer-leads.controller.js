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
const { cleanStrangerText, cleanNotes, hasSubstance } = require('../lib/text')
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
// Invisible and direction-changing characters (zero-width, bidi override, Hangul fillers, the
// Unicode TAG block, LRM/RLM/ALM …) are removed outright. The list lives in ONE place —
// lib/text.js — shared with account names; this file used to carry its own, stricter copy and the
// two drifted apart.
const cleanText = cleanStrangerText
const text = (max, { min = 0 } = {}) =>
  z.string().transform(cleanText).pipe(z.string().min(min).max(max))
// A required name/company must contain at least one letter or digit — "-",
// "..." and emoji-only values are not a name.
const required = (max) => text(max, { min: 1 }).refine(hasSubstance, { message: 'Enter a real value.' })

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
const RESUBMIT_DIFF_NOTICE_COOLDOWN_MS = 60 * 60 * 1000
// Round 10 (Section 5): an ARCHIVED lead that submits the form again stays archived (the admin's
// dismissal stands, and a spammer must not be able to reopen themselves), but the admin is told
// once a week that it came back, and the lead is flagged in the list (archived_resubmitted_at).
const ARCHIVED_RESUBMIT_NOTICE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
// How many fields besides the primary one a lead can be hiring in (matches the 0062 check).
const MAX_EXTRA_FIELDS = 4
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

// BUG FIX (independent audit round 8, Section 5): FRONTEND_URL was used raw here, so a value
// with a trailing slash (env.js only WARNS about that) put "//" in every confirm / remove link,
// while unsubscribeRedirect below already trimmed it. One helper, used by both.
const frontendBase = (env) => String((env && env.FRONTEND_URL) || '').replace(/\/+$/, '')

async function leadLinks(env, email, origin = null) {
  const [confirmTok, removeTok] = await Promise.all([
    signLeadToken(leadLinkSecrets(env).sign, 'confirm', email),
    signLeadToken(leadLinkSecrets(env).sign, 'remove', email)
  ])
  const base = frontendBase(env)
  return {
    confirmUrl: `${base}/employer/confirm?token=${confirmTok}`,
    removeUrl:  `${base}/employer/remove?token=${removeTok}`,
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
//
// Round 10 (Section 5): split into attemptAck, which also says WHY nothing went out, so the
// acknowledgement sweep below can tell "the hourly budget is spent, stop for now" (not the
// lead's fault) from "this address failed" (counts against its bounded retries).
async function attemptAck(env, row, { skipBudget = false, origin = null } = {}) {
  let refund = async () => {}
  if (!skipBudget) {
    const budget = await withinBudget(env, 'leadack', ACK_BUDGET_PER_HOUR, ACK_MAX_REFUNDS_PER_HOUR)
    if (!budget.allowed) {
      console.warn(`Employer-lead acknowledgement budget (${ACK_BUDGET_PER_HOUR}/h) exhausted — skipped`)
      return { sent: false, reason: 'budget' }
    }
    refund = budget.refund
  }
  try {
    const sent = await emailService.sendEmployerLeadAck(
      env, getSupabase(env), row.email, row.name, fieldLabel(row.role_category), await leadLinks(env, row.email, origin))
    if (!sent) await refund()
    else await stampLead(env, { email: row.email }, { last_ack_at: new Date().toISOString() })
    return { sent: !!sent, reason: sent ? 'sent' : 'failed' }
  } catch (err) {
    console.error('Employer-lead acknowledgement failed:', err.message)
    await refund()
    return { sent: false, reason: 'failed' }
  }
}

async function sendAck(env, row, opts) {
  return (await attemptAck(env, row, opts)).sent
}

async function runInBackground(c, task) {
  try { c.executionCtx.waitUntil(task) } catch (_) { await task }
}

async function notifyOwner(c, subject, message) {
  await runInBackground(c, sendNotice(c.env, subject, message))
}

const describeLead = (row) =>
  `name: ${row.name}\ncompany: ${row.company}\nemail: ${row.email}\n` +
  `field: ${row.role_category || '(none)'}${(row.extra_role_categories || []).length ? ` (also: ${row.extra_role_categories.join(', ')})` : ''}\nrole: ${row.role_title || '(none)'}\n` +
  `source: ${row.source}${row.source_code ? ` (/v/${row.source_code})` : ''}`

// Everything that follows a lead being stored for the first time. Runs after the response has
// gone (see createLead), so it awaits its two sends directly.
//
// BUG FIX (independent audit round 8, Section 5): createLead checks the do-not-contact list and
// THEN inserts, so a "remove me" that landed between the two (the person clicking the link in an
// older email while the form was being submitted) left a brand-new lead standing for an address
// that had just opted out — and mailed the owner and the address about it. The list is read
// again now that the row exists; if it says suppressed, the row goes and nothing is sent.
async function finishNewLead(c, supabase, row, origin) {
  let suppressedNow = false
  try { suppressedNow = await isSuppressed(supabase, row.email) }
  catch (err) { console.error('employer-leads: post-insert suppression check failed:', err.message) }
  if (suppressedNow) {
    const { error } = await supabase.from('employer_leads').delete().eq('email', row.email)
    if (error) console.error('employer-leads: could not drop a lead stored while its address was being removed:', error.message)
    return
  }
  await Promise.all([
    sendNotice(c.env, 'New employer lead', describeLead(row)),
    sendAck(c.env, row, { origin })
  ])
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
async function mergeIntoExistingLead(c, supabase, existing, row, origin = null) {
  const now = new Date()
  const patch = {
    submission_count:  (existing.submission_count || 1) + 1,
    last_submitted_at: now.toISOString(),
    updated_at:        now.toISOString()
  }
  if (!existing.role_category && row.role_category) patch.role_category = row.role_category
  const archived = existing.status === 'ARCHIVED'
  if (archived) patch.archived_resubmitted_at = now.toISOString()
  // BUG FIX (independent audit round 9, Section 5): the three gap-fills used to be independent, so
  // a `sales` lead resubmitting as "Data Science / ML lead" came out as field `sales` with title
  // "ML lead" — an incoherent row — and the different field was dropped without a trace. The title
  // is now only filled when it belongs to the field the lead ends up with; anything that was NOT
  // taken is reported to the owner below instead of vanishing.
  const categoryAfter = patch.role_category || existing.role_category || null
  if (!existing.role_title && row.role_title && (!row.role_category || !categoryAfter || row.role_category === categoryAfter))
    patch.role_title = row.role_title
  if (!existing.source_code   && row.source_code)   patch.source_code   = row.source_code
  // Round 10 (Section 5): an employer hiring in a SECOND field used to have that field reported to
  // the owner once and then lost — they were only ever matched with candidates in the first one.
  // A different, valid field is now kept on the lead (not for an archived lead: the owner decides
  // whether it is worth working again first).
  const extras = Array.isArray(existing.extra_role_categories) ? existing.extra_role_categories : []
  let addedField = null
  if (!archived && categoryAfter && row.role_category && row.role_category !== categoryAfter &&
      !extras.includes(row.role_category) && extras.length < MAX_EXTRA_FIELDS) {
    patch.extra_role_categories = [...extras, row.role_category]
    addedField = row.role_category
  }
  const stored = { ...existing, ...patch }
  // What this submission said that the lead now does NOT say (name/company are never overwritten
  // either). The field and the page it came from matter most: they decide whether this person is
  // matched with candidates, and which candidate's page brought them back.
  const DIFF_LABELS = { name: 'name', company: 'company', role_category: 'field', role_title: 'role', source_code: 'came from page' }
  const changed = Object.keys(DIFF_LABELS)
    .filter(k => row[k] && stored[k] !== row[k] && !(k === 'role_category' && addedField))
    .map(k => `${DIFF_LABELS[k]}: ${k === 'role_category' ? fieldLabel(row[k]) : row[k]}`)

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
  // An archived lead's first "it came back" notice must not be held back by how recently the lead
  // was CREATED, so it has no created_at fallback.
  const lastNoticeMs = archived ? sinceMs(existing.last_notice_at) : sinceMs(existing.last_notice_at, existing.created_at)

  // This only ever runs after the response has gone (settleDuplicate, via createLead), so the two
  // sends below are awaited right here rather than handed to waitUntil a second time.
  const sends = []

  // Never confirmed and not dismissed: they may simply not have seen the first
  // email, so send it again (capped per recipient in email.service.js).
  if (!existing.confirmed_at && !archived && now.getTime() - lastAckMs > ACK_RESEND_COOLDOWN_MS)
    sends.push(sendAck(c.env, existing, { origin }))

  // Worth a heads-up only if it's not a lead the admin dismissed and hasn't
  // already been announced recently (a hiring manager clicking twice isn't news).
  // A resubmission that carries different details gets a shorter cooldown than a plain repeat:
  // a lead who now says they are hiring in another field must not be silenced for a day.
  const noticeCooldown = archived ? ARCHIVED_RESUBMIT_NOTICE_COOLDOWN_MS
    : (changed.length || addedField) ? RESUBMIT_DIFF_NOTICE_COOLDOWN_MS : RESUBMIT_NOTICE_COOLDOWN_MS
  if (now.getTime() - lastNoticeMs > noticeCooldown) {
    const message = `${describeLead(existing)}\nsubmissions: ${patch.submission_count}` +
      (archived ? '\n\nThis lead is ARCHIVED, so it stays archived and nothing was sent to them. Move it back to New in the admin list if you want to work it.' : '') +
      (addedField ? `\n\nThey are now also hiring in: ${fieldLabel(addedField)} (added to the lead).` : '') +
      (changed.length ? `\n\nThis time they entered different details (not saved over the lead — edit it if this is a real change):\n${changed.join('\n')}` : '')
    // Stamped only if the notice really went out, so a skipped (budget) or failed one is retried
    // by the next resubmission rather than silenced for a day.
    sends.push((async () => {
      if (await sendNotice(c.env, archived ? 'Archived employer lead resubmitted' : 'Employer lead resubmitted', message))
        await stampLead(c.env, { id: existing.id }, { last_notice_at: now.toISOString() })
    })())
  }
  await Promise.all(sends)
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
  if (await isSuppressed(supabase, data.email)) {
    // BUG FIX (independent audit round 9, Section 5): this branch used to answer one database round
    // trip sooner than the insert path every other address takes, so response time still told a
    // caller whether an address had opted out. A throwaway lookup keeps the two the same length.
    await supabase.from('employer_leads').select('id').eq('email', data.email).limit(1).then(() => {}, () => {})
    return ok(c)
  }
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

  // The only work done before answering is the insert attempt. Everything after it — merging a
  // resubmission, announcing a new lead, re-checking the do-not-contact list — runs in the
  // background.
  //
  // BUG FIX (independent audit round 8, Section 5): a brand-new address, an address that is
  // already a lead (insert fails, read, update — three more round trips) and a suppressed one
  // took visibly different times to answer, so the public form told anyone who timed it whether
  // an employer's address was already on the list. The comment on notifyOwner promised exactly
  // that could not be told apart, but only covered the emails. A duplicate is now settled after
  // the response, so a new and an existing address cost the submitter the same single insert.
  const origin = apiOrigin(c)
  const { error: insertErr } = await supabase.from('employer_leads').insert(row)
  if (!insertErr) {
    await runInBackground(c, finishNewLead(c, supabase, row, origin)
      .catch(err => console.error('employer-leads: new-lead follow-up failed:', err.message)))
    return ok(c)
  }
  if (insertErr.code !== '23505') throw insertErr
  await runInBackground(c, settleDuplicate(c, supabase, row, origin)
    .catch(err => console.error('employer-leads: could not merge a resubmission:', err.message)))
  return ok(c)
}

// A submission for an address that already has a lead (or had one a moment ago). Each pass
// re-derives what to do from the database's actual current state — merge if the address is a
// lead, insert if it is free — rather than ever falling back to "pretend it worked": a row
// deleted between our insert attempt and our read (an admin, or the person's own removal) is
// stored again, and an update that lost a race re-reads and decides again. Bounded, so a very
// sustained collision ends instead of looping; the address is a real lead by then either way.
async function settleDuplicate(c, supabase, row, origin) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: existing, error: selErr } = await supabase
      .from('employer_leads').select('*').eq('email', row.email).maybeSingle()
    if (selErr) throw selErr
    if (!existing) {
      const { error: insErr } = await supabase.from('employer_leads').insert(row)
      if (!insErr) return finishNewLead(c, supabase, row, origin)
      if (insErr.code !== '23505') throw insErr
      continue
    }
    if (await mergeIntoExistingLead(c, supabase, existing, row, origin) === 'ok') return
  }
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
    // Round 10: unconfirmed leads we have never managed to email, and archived leads that came back.
    ack: c.req.query('ack') === 'never' ? 'never' : null,
    reengaged: c.req.query('reengaged') === 'yes' ? 'yes' : null,
    sort
  }
}

function applyFilters(query, { search, status, field, source, confirmed, ack, reengaged }) {
  // Fresh audit pass 2 (G7): also matches the verification page code a lead came
  // from and the admin's own notes — both were visible in the UI but unsearchable.
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,role_title.ilike.%${search}%,source_code.ilike.%${search}%,notes.ilike.%${search}%`)
  if (status === 'OPEN') query = query.in('status', OPEN_STATUSES)
  else if (status) query = query.eq('status', status)
  if (field === 'none') query = query.is('role_category', null)
  else if (field) query = query.or(`role_category.eq.${field},extra_role_categories.cs.{${field}}`)
  if (source) query = query.eq('source', source)
  if (confirmed === 'yes') query = query.not('confirmed_at', 'is', null)
  else if (confirmed === 'no') query = query.is('confirmed_at', null)
  if (ack === 'never') query = query.is('last_ack_at', null).is('confirmed_at', null).neq('status', 'ARCHIVED')
  if (reengaged === 'yes') query = query.not('archived_resubmitted_at', 'is', null)
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
  // Round 10: the two "needs a look" tallies behind the new list filters. Best-effort — a database
  // that has not run migration 0062 yet must still list its leads.
  const countWhere = async (build) => {
    const { count: n, error: e } = await build(supabase.from('employer_leads').select('id', { count: 'exact', head: true }))
    if (e) { console.error('employer-leads: could not count a list tally:', e.message); return null }
    return n || 0
  }
  const [neverEmailed, reengaged] = await Promise.all([
    countWhere(q => q.is('last_ack_at', null).is('confirmed_at', null).neq('status', 'ARCHIVED')),
    countWhere(q => q.not('archived_resubmitted_at', 'is', null))
  ])

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
    meta: { page, pageSize, total: count || 0, counts, sourceCounts, unconfirmed: uErr ? null : (unconfirmed || 0), neverEmailed, reengaged, suppressed, candidateSupply: supply } })
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
  ['Email confirmed at', r => r.confirmed_at],
  // FEATURE GAP CLOSED (independent audit round 8, Section 5): the outreach clocks and the row id
  // were in the table and the list API but not the export, so a spreadsheet could not answer "who
  // did we last tell, and when". Appended, so existing column positions do not move.
  ['Acknowledgement last sent', r => r.last_ack_at], ['Resubmission notice last sent', r => r.last_notice_at],
  ['Candidates last notified', r => r.last_candidates_notified_at], ['Lead id', r => r.id],
  ['Also hiring in', r => (r.extra_role_categories || []).join('; ')],
  ['Acknowledgement attempts (sweep)', r => r.ack_attempts],
  ['Resubmitted while archived at', r => r.archived_resubmitted_at]
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
    // BUG FIX (independent audit round 8, Section 5): this used to stop as soon as a page came back
    // shorter than asked for, taking that for "the last page". A project whose PostgREST max-rows
    // is set below EXPORT_CHUNK answers EVERY page short, so the export ended after one page,
    // silently, with X-Export-Truncated: false. Only an empty page ends it now (one cheap extra
    // request on a normal export).
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
    filters: Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && k !== 'search' && !(k === 'sort' && v === 'created'))),
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
  roleTitle:    text(100).nullable().optional(),
  // Round 10 (Section 5): a typo in the address used to mean delete-and-recreate (losing the
  // history), and the other fields an employer is hiring in could not be edited at all.
  email:        z.string().trim().toLowerCase().max(254).email().optional(),
  extraRoleCategories: z.array(z.enum(ROLE_CATEGORIES)).max(MAX_EXTRA_FIELDS).optional()
}).refine(d => Object.values(d).some(v => v !== undefined), { message: 'Nothing to update.' })

// PATCH /api/employer-leads/:id — admin only. Any subset of the fields.
// contacted_at is stamped the first time a lead reaches CONTACTED (or CONVERTED).
async function adminUpdateLeadStatus(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const d = updateSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)

  const { data: existing, error: readErr } = await supabase
    .from('employer_leads').select('id, contacted_at, email, status, role_category, extra_role_categories').eq('id', id).maybeSingle()
  if (readErr) throw readErr
  if (!existing) return c.json({ success: false, message: 'Lead not found.' }, 404)

  const patch = { updated_at: new Date().toISOString() }
  // Any decision about the status — including re-archiving — answers "it came back" for now.
  if (d.status  !== undefined) { patch.status = d.status; patch.archived_resubmitted_at = null }
  if (d.notes   !== undefined) patch.notes   = d.notes || null
  if (d.name    !== undefined) patch.name    = d.name
  if (d.company !== undefined) patch.company = d.company
  if (d.roleCategory !== undefined) patch.role_category = d.roleCategory
  if (d.roleTitle    !== undefined) patch.role_title    = d.roleTitle || null
  if (CONTACTED_STATUSES.includes(d.status) && !existing.contacted_at) patch.contacted_at = patch.updated_at

  // The other fields never include the primary one, and without a primary there is nothing for
  // them to be "other" than.
  const primaryAfter = d.roleCategory !== undefined ? d.roleCategory : existing.role_category
  if (d.extraRoleCategories !== undefined || d.roleCategory !== undefined) {
    const source = d.extraRoleCategories !== undefined ? d.extraRoleCategories : (existing.extra_role_categories || [])
    const extras = [...new Set(source)].filter(f => f !== primaryAfter)
    // Clearing the main field quietly clears the others with it; ASKING for others without one is the mistake.
    if (d.extraRoleCategories !== undefined && extras.length && !primaryAfter)
      return c.json({ success: false, message: 'Pick the main field before adding other fields.' }, 400)
    patch.extra_role_categories = primaryAfter ? extras : []
  }

  // A new address is a new person to ask: nothing about the old one's confirmation, acknowledgement
  // or candidate notices carries over. A do-not-contact address stays that way.
  const emailChanged = d.email !== undefined && d.email !== existing.email
  if (emailChanged) {
    if (await isSuppressed(supabase, d.email))
      return c.json({
        success: false, code: 'REMOVAL_REQUESTED',
        message: 'That address asked to be removed and is on the do-not-contact list. Lift the removal first if they have since asked you to.'
      }, 409)
    Object.assign(patch, {
      email: d.email, confirmed_at: null, last_ack_at: null, ack_attempts: 0, last_ack_attempt_at: null,
      last_candidates_notified_at: null
    })
  }

  const { data, error } = await supabase
    .from('employer_leads').update(patch).eq('id', id).select().maybeSingle()
  if (error) {
    if (error.code === '23505') return c.json({ success: false, message: 'A lead with that email already exists.' }, 409)
    throw error
  }
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)
  // Field NAMES and the status transition only — never the values typed.
  await logAdminAction(c, supabase, 'lead.update', 'employer_lead', id, {
    fields: Object.keys(d).filter(k => d[k] !== undefined),
    ...(d.status !== undefined ? { status: d.status } : {}),
    ...(emailChanged ? { emailChanged: true } : {})
  })
  // Ask the corrected address to confirm straight away (never an archived lead — that one is not
  // being worked). Like every first email, it goes after the response.
  if (emailChanged && data.status !== 'ARCHIVED')
    await runInBackground(c, sendAck(c.env, data, { origin: apiOrigin(c) }))
  return c.json({ success: true, data: leadRowToCamel(data), ...(emailChanged ? { confirmationReset: true } : {}) })
}

// POST /api/employer-leads/bulk — admin only. Clearing a spam wave or marking
// a batch contacted was one request per row.
//
// FEATURE GAP CLOSED (independent audit round 8, Section 5): four more batch actions, each of
// which was a click per lead before:
//   deleteAndSuppress   — delete AND put the addresses on the do-not-contact list (a spam wave)
//   setField            — categorise leads that arrived without a field (they can never be
//                         matched against candidate supply, or told about it, until they have one)
//   markConfirmed       — the admin's word that the addresses are the submitters' (see
//                         adminMarkConfirmed), for the backlog of leads from before confirmation existed
//   requestConfirmation — mail those leads their confirm link (per-address cap still applies)
const BULK_MAX = 100
// Each acknowledgement costs several subrequests (limiter, provider, mail log, stamp), so a
// batch of them is smaller than the batch of plain row updates.
const BULK_MAIL_MAX = 25
const BULK_ACTIONS = ['setStatus', 'delete', 'deleteAndSuppress', 'setField', 'markConfirmed', 'requestConfirmation']
const bulkSchema = z.object({
  ids:    z.array(z.string().regex(UUID_RE, 'Invalid lead id.')).min(1).max(BULK_MAX),
  action: z.enum(BULK_ACTIONS),
  status: z.enum(LEAD_STATUSES).optional(),
  // null = clear the field (back to "uncategorised").
  field:  z.enum(ROLE_CATEGORIES).nullable().optional()
})
  .refine(d => d.action !== 'setStatus' || d.status !== undefined, { message: 'status required for setStatus.' })
  .refine(d => d.action !== 'setField' || d.field !== undefined, { message: 'field required for setField.' })
  .refine(d => d.action !== 'requestConfirmation' || d.ids.length <= BULK_MAIL_MAX, { message: `At most ${BULK_MAIL_MAX} leads per confirmation batch.` })

async function adminBulkUpdateLeads(c) {
  const { ids: rawIds, action, status, field } = bulkSchema.parse(await c.req.json())
  const ids = [...new Set(rawIds.map(i => i.toLowerCase()))]
  const supabase = getSupabase(c.env)

  if (action === 'delete' || action === 'deleteAndSuppress') {
    const suppress = action === 'deleteAndSuppress'
    let emails = []
    if (suppress) {
      const { data: found, error: readErr } = await supabase.from('employer_leads').select('id, email').in('id', ids)
      if (readErr) throw readErr
      emails = [...new Set((found || []).map(r => r.email))]
      await recordSuppressions(supabase, emails)
    }
    const { data, error } = await supabase.from('employer_leads').delete().in('id', ids).select('id')
    if (error) throw error
    if (suppress) await purgeAddressLogs(supabase, emails)
    await logAdminAction(c, supabase, 'lead.bulk_delete', 'employer_lead', null,
      { ids: (data || []).map(r => r.id), ...(suppress ? { suppressed: true } : {}) })
    return c.json({ success: true, affected: (data || []).length })
  }

  const now = new Date().toISOString()

  if (action === 'setField') {
    const { data, error } = await supabase
      .from('employer_leads').update({ role_category: field, updated_at: now }).in('id', ids).select('id, extra_role_categories')
    if (error) throw error
    // The new primary field must not also sit in the "other fields" list, and a lead with no
    // primary field has no others. Only the few rows that need it are touched again.
    for (const r of data || []) {
      const extras = r.extra_role_categories || []
      const fixed = field ? extras.filter(f => f !== field) : []
      if (fixed.length === extras.length) continue
      const { error: extraErr } = await supabase.from('employer_leads').update({ extra_role_categories: fixed }).eq('id', r.id)
      if (extraErr) throw extraErr
    }
    await logAdminAction(c, supabase, 'lead.bulk_field', 'employer_lead', null, { field, ids: (data || []).map(r => r.id) })
    return c.json({ success: true, affected: (data || []).length })
  }

  if (action === 'markConfirmed') {
    // `.is('confirmed_at', null)` keeps an address that confirmed itself a moment ago from having
    // its real confirmation time overwritten by the admin's.
    const { data, error } = await supabase
      .from('employer_leads').update({ confirmed_at: now, updated_at: now }).in('id', ids).is('confirmed_at', null).select('id')
    if (error) throw error
    await logAdminAction(c, supabase, 'lead.bulk_mark_confirmed', 'employer_lead', null, { ids: (data || []).map(r => r.id) })
    return c.json({ success: true, affected: (data || []).length })
  }

  if (action === 'requestConfirmation') {
    const { data: leads, error } = await supabase.from('employer_leads').select('*').in('id', ids).is('confirmed_at', null)
      // BUG FIX (independent audit round 9, Section 5): an ARCHIVED lead is one the admin dismissed —
      // every public path already refuses to re-mail it, but this one (and the single-lead twin
      // below) only had a client-side guard, so a bulk selection mailed dismissed addresses.
      .neq('status', 'ARCHIVED')
    if (error) throw error
    const origin = apiOrigin(c)
    const sentIds = []
    let failed = 0
    // One at a time: each send reserves its own per-address slot and may be refused by it.
    for (const lead of leads || []) {
      if (await sendAck(c.env, lead, { skipBudget: true, origin })) sentIds.push(lead.id)
      else failed++
    }
    const skipped = ids.length - (leads || []).length   // already confirmed, archived, or gone
    await logAdminAction(c, supabase, 'lead.bulk_request_confirmation', 'employer_lead', null, { ids: sentIds, failed, skipped })
    return c.json({ success: true, affected: sentIds.length, sent: sentIds.length, failed, skipped })
  }

  const { data, error } = await supabase
    .from('employer_leads').update({ status, updated_at: now, archived_resubmitted_at: null }).in('id', ids).select('id')
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
//
// FEATURE GAP CLOSED (independent audit round 8, Section 5): `?suppress=true` also puts the
// address on the do-not-contact list (and clears its mail history), for the lead that is spam or
// abuse: a plain delete leaves nothing behind, so the same address could resubmit the public
// form at once and notify the owner all over again. Same order as removeLead — list first, row last.
async function adminDeleteLead(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)
  const suppress = c.req.query('suppress') === 'true'

  const supabase = getSupabase(c.env)
  if (suppress) {
    const { data: lead, error: readErr } = await supabase.from('employer_leads').select('id, email').eq('id', id).maybeSingle()
    if (readErr) throw readErr
    if (!lead) return c.json({ success: false, message: 'Lead not found.' }, 404)
    await recordSuppressions(supabase, [lead.email])
  }
  const { data, error } = await supabase
    .from('employer_leads').delete().eq('id', id).select().maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)
  if (suppress) await purgeAddressLogs(supabase, [data.email])
  await logAdminAction(c, supabase, 'lead.delete', 'employer_lead', id, suppress ? { suppressed: true } : {})
  return c.json({ success: true, message: suppress ? 'Lead deleted and its address added to the do-not-contact list.' : 'Lead deleted.' })
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
  if (lead.confirmed_at) return c.json({ success: true, status: 'already', needsField: !lead.role_category, message: 'This address is already confirmed.' })

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
  return c.json({ success: true, status: 'confirmed', needsField: !lead.role_category, message: "Thanks — your email is confirmed. We'll be in touch when there are Verified candidates in your field." })
}

// POST /api/employer-leads/field { token, field }
// FEATURE GAP CLOSED (independent audit round 9, Section 5): the field is optional on both forms,
// and a lead without one can never be matched with candidates, announced in the owner digest or
// notified — only an admin could fix that, by guessing. The person who CAN is the inbox owner, and
// the confirm link already proves they are: the confirmed page now asks, and this saves the answer.
// Same signed token as /confirm (purpose "confirm"), so it needs no login and reveals nothing the
// token holder does not already know. It sets the field only — never name, company or status.
const fieldBodySchema = z.object({ token: z.string().min(10).max(700), field: z.enum(ROLE_CATEGORIES) })
async function setLeadField(c) {
  const { token, field } = fieldBodySchema.parse(await c.req.json())
  const email = await verifyLeadToken(leadLinkSecrets(c.env).verify, 'confirm', token)
  if (!email) return c.json(INVALID_LINK, 400)

  const supabase = getSupabase(c.env)
  const { data: updated, error } = await supabase
    .from('employer_leads').update({ role_category: field, updated_at: new Date().toISOString() })
    .eq('email', email).select('id').maybeSingle()
  if (error) throw error
  if (!updated) return c.json({ success: true, status: 'not_found', message: 'We no longer have a request for this address.' })
  return c.json({ success: true, status: 'saved', message: "Thanks — we'll email you when there are Verified candidates in that field." })
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

// The do-not-contact list stores only hashes, so recording an address is one upsert of its hash.
// Takes a list so a bulk delete-and-block is one write, not one per lead.
async function recordSuppressions(supabase, emails) {
  if (!emails.length) return
  const rows = await Promise.all(emails.map(async (e) => ({ email_hash: await sha256(e) })))
  const { error } = await supabase
    .from('employer_lead_suppressions').upsert(rows.length === 1 ? rows[0] : rows, { onConflict: 'email_hash', ignoreDuplicates: true })
  if (error) throw error
}

// FEATURE GAP CLOSED (independent audit round 8, Section 5): removing a lead used to erase the
// lead row and nothing else — email_logs still held the address (every acknowledgement and
// candidates mail we ever sent it) for the 90-day log retention, which sits badly next to the
// remove page's promise to delete the request. Only the two employer templates are touched: the
// address may also belong to a candidate's account, whose own mail history is not this list's.
//
// BEST EFFORT, and always the LAST step: the opt-out itself (the hash and the deleted lead) is what a
// person is owed and must never be held up by housekeeping. A failed purge is logged and the
// rows simply age out with the 90-day log retention, exactly as they did before this existed.
const EMPLOYER_MAIL_TEMPLATES = ['employer_lead_ack', 'employer_candidates_available']
async function purgeAddressLogs(supabase, emails) {
  if (!emails.length) return true
  try {
    const { error } = await supabase.from('email_logs').delete().in('to', emails).in('template', EMPLOYER_MAIL_TEMPLATES)
    if (error) throw error
    return true
  } catch (err) {
    console.error('employer-leads: could not clear the mail history of a removed address:', err.message)
    return false
  }
}

// Every step is safe to repeat: the hash first (so nothing can re-create the lead), then the lead
// row, then the mail history.
async function performRemoval(supabase, email) {
  await recordSuppressions(supabase, [email])
  const { error: delErr } = await supabase.from('employer_leads').delete().eq('email', email)
  if (delErr) throw delErr
  await purgeAddressLogs(supabase, [email])
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
  const base = frontendBase(c.env)
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
  await recordSuppressions(supabase, [email])
  const { data: removed, error: delErr } = await supabase
    .from('employer_leads').delete().eq('email', email).select('id')
  if (delErr) throw delErr
  await purgeAddressLogs(supabase, [email])
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
  if (lead.status === 'ARCHIVED') return c.json({ success: false, message: 'This lead is archived. Move it back to New before asking it to confirm.' }, 409)

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

// BUG FIX (independent audit round 8, Section 5): a send that fails because the address already
// got this very email inside the cooldown (the per-recipient cap in email.service.js) never
// stamped the lead — which happens whenever the stamp was lost (the lead was deleted and added
// back, or the stamp write failed). That lead stayed eligible and sorted first on EVERY call,
// counted as "failed" and "still waiting" each time, and held a slot in the examine window
// forever. The mail log knows it was told: adopt that time as the stamp, so the lead leaves the
// queue until its 30 days are really up. Returns true when it did.
async function adoptEarlierNotification(supabase, lead) {
  try {
    const since = new Date(Date.now() - NOTIFY_COOLDOWN_MS).toISOString()
    const { data, error } = await supabase.from('email_logs').select('sent_at')
      .eq('to', lead.email).eq('template', 'employer_candidates_available').eq('status', 'sent').gte('sent_at', since)
      .order('sent_at', { ascending: false }).limit(1)
    if (error || !Array.isArray(data) || !data.length) return false
    const { error: stampErr } = await supabase.from('employer_leads')
      .update({ last_candidates_notified_at: data[0].sent_at }).eq('id', lead.id)
    return !stampErr
  } catch (_) { return false }
}

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
    .or(`role_category.eq.${field},extra_role_categories.cs.{${field}}`)
    .not('confirmed_at', 'is', null).in('status', OPEN_STATUSES)
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
    if (!ok) {
      if (await adoptEarlierNotification(supabase, lead)) skipped++
      else failed++
      continue
    }
    sent++; sentIds.push(lead.id)
    const stamp = new Date().toISOString()
    const patch = { last_candidates_notified_at: stamp, updated_at: stamp }
    if (lead.status === 'NEW') patch.status = 'CONTACTED'
    if (!lead.contacted_at) patch.contacted_at = stamp
    const { error: stampErr } = await supabase.from('employer_leads').update(patch).eq('id', lead.id)
    if (stampErr) console.error('Employer-lead candidate notification sent but not recorded:', stampErr.message)
  }
  await logAdminAction(c, supabase, 'lead.notify_candidates', 'employer_lead', null, { field, candidates, sent, failed, skipped, ids: sentIds })
  return c.json({ success: true, data: { field, candidates, eligible: total, sent, failed, skipped, remaining: Math.max(0, total - sent - skipped - failed) } })
}

// ── Admin: bulk import ──────────────────────────────────────────────────────

// Round 10 (Section 5): export existed, import did not — leads met at an event or kept in a
// spreadsheet had to be added one at a time. The browser parses the file and sends rows in
// batches; every row is judged on its own and the response says what happened to each problem
// row. Like a single manual add, an imported lead counts as confirmed because the admin vouches
// for it — which is why the request must say so (`attest`), and why an address on the
// do-not-contact list is never overridden here (lift it deliberately, one address at a time).
const IMPORT_MAX_ROWS = 500
const IMPORT_REPORT_MAX = 50
const importRowSchema = z.object({
  name:    required(100),
  company: required(200),
  email:   z.string().trim().toLowerCase().max(254).email(),
  field:   z.string().max(100).nullish(),
  role:    text(100).nullish(),
  notes:   z.string().max(2000).transform(cleanNotes).nullish()
})
const importSchema = z.object({
  rows:    z.array(z.record(z.unknown())).min(1).max(IMPORT_MAX_ROWS),
  attest:  z.literal(true, { errorMap: () => ({ message: 'Confirm that these contacts asked to hear from you.' }) }),
  dryRun:  z.boolean().optional()
})

const fieldKey = (raw) => String(raw || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

// `.in()` travels in the URL; 500 SHA-256 hashes would be ~35 KB of it, past what the REST gateway
// accepts. Lookups go out in small groups.
const IN_LOOKUP_CHUNK = 50
const inChunks = (list) => { const out = []; for (let i = 0; i < list.length; i += IN_LOOKUP_CHUNK) out.push(list.slice(i, i + IN_LOOKUP_CHUNK)); return out }

async function suppressedAmong(supabase, emails) {
  if (!emails.length) return new Set()
  const byHash = new Map(await Promise.all(emails.map(async (e) => [await sha256(e), e])))
  const hit = new Set()
  for (const group of inChunks([...byHash.keys()])) {
    const { data, error } = await supabase.from('employer_lead_suppressions').select('email_hash').in('email_hash', group)
    if (error) {
      if (MISSING_RELATION.includes(error.code)) return new Set()
      throw error
    }
    for (const r of data || []) if (byHash.has(r.email_hash)) hit.add(byHash.get(r.email_hash))
  }
  return hit
}

async function adminImportLeads(c) {
  const { rows: rawRows, dryRun } = importSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const problems = []
  const note = (line, email, reason) => { if (problems.length < IMPORT_REPORT_MAX) problems.push({ line, email: email || null, reason }) }
  const tally = { invalid: 0, duplicateInFile: 0, exists: 0, removed: 0, fieldIgnored: 0 }

  const seen = new Set()
  const valid = []
  rawRows.forEach((raw, i) => {
    const line = i + 1
    const r = importRowSchema.safeParse(raw)
    if (!r.success) {
      tally.invalid++
      note(line, typeof raw.email === 'string' ? raw.email : null, r.error.issues[0]?.message || 'Invalid row.')
      return
    }
    const d = r.data
    if (seen.has(d.email)) { tally.duplicateInFile++; note(line, d.email, 'Repeated in this file.'); return }
    seen.add(d.email)
    const key = fieldKey(d.field)
    const known = ROLE_CATEGORIES.includes(key)
    if (d.field && d.field.trim() && !known) { tally.fieldIgnored++; note(line, d.email, `Field "${d.field.trim()}" is not one of ours; imported without a field.`) }
    valid.push({ line, d, key: known ? key : null })
  })

  const emails = valid.map(v => v.d.email)
  const existing = new Set()
  for (const group of inChunks(emails)) {
    const { data: existingRows, error: exErr } = await supabase.from('employer_leads').select('email').in('email', group)
    if (exErr) throw exErr
    for (const r of existingRows || []) existing.add(r.email)
  }
  const removed = await suppressedAmong(supabase, emails.filter(e => !existing.has(e)))

  const now = new Date().toISOString()
  const toInsert = []
  for (const v of valid) {
    if (existing.has(v.d.email)) { tally.exists++; note(v.line, v.d.email, 'Already a lead.'); continue }
    if (removed.has(v.d.email)) { tally.removed++; note(v.line, v.d.email, 'Asked to be removed — not imported.'); continue }
    toInsert.push({
      name: v.d.name, company: v.d.company, email: v.d.email,
      role_category: v.key, role_title: v.d.role || null, notes: v.d.notes || null,
      status: 'NEW', source: 'manual', confirmed_at: now
    })
  }

  let created = 0
  if (!dryRun && toInsert.length) {
    const { error } = await supabase.from('employer_leads').insert(toInsert)
    if (!error) created = toInsert.length
    else if (error.code !== '23505') throw error
    else {
      // Someone (a form submission, another admin) added one of these addresses a moment ago.
      // Settle the rest one by one rather than dropping the whole batch.
      for (const row of toInsert) {
        const { error: oneErr } = await supabase.from('employer_leads').insert(row)
        if (!oneErr) created++
        else if (oneErr.code === '23505') { tally.exists++; note(null, row.email, 'Already a lead.') }
        else throw oneErr
      }
    }
  }
  const wouldCreate = dryRun ? toInsert.length : created
  if (!dryRun) await logAdminAction(c, supabase, 'lead.import', 'employer_leads', null, { rows: rawRows.length, created, ...tally })
  return c.json({ success: true, data: { dryRun: !!dryRun, rows: rawRows.length, created: dryRun ? 0 : created, wouldCreate, ...tally, problems } })
}

// ── Acknowledgement retry (hourly cron) ─────────────────────────────────────

// Round 10 (Section 5): a new lead's confirmation email was tried exactly once, after the
// response. A spent hourly budget, a Resend hiccup or a cut-off isolate left the lead
// unacknowledged for good — and the unconfirmed-lead purge later deleted it without it ever
// having been asked to confirm. This runs from the hourly cron: the oldest never-acknowledged
// leads get their email, within the same hourly budget as live submissions (so it can never
// outrun it), each lead at most LEAD_ACK_MAX_ATTEMPTS times and not more often than every
// ACK_SWEEP_RETRY_GAP_MS, so a lead whose address always fails cannot starve the ones behind it.
const ACK_SWEEP_BATCH = 20
const ACK_SWEEP_GRACE_MS = 15 * 60 * 1000          // the first attempt (after the response) gets this long
const ACK_SWEEP_RETRY_GAP_MS = 6 * 60 * 60 * 1000
const ACK_SWEEP_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000

async function sweepUnacknowledgedLeads(env, supabase = getSupabase(env), now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString()
  const { data: leads, error } = await supabase.from('employer_leads').select('*')
    .is('last_ack_at', null).is('confirmed_at', null).neq('status', 'ARCHIVED')
    .lt('ack_attempts', constants.LEAD_ACK_MAX_ATTEMPTS)
    .lt('created_at', iso(now - ACK_SWEEP_GRACE_MS)).gt('created_at', iso(now - ACK_SWEEP_MAX_AGE_MS))
    .or(`last_ack_attempt_at.is.null,last_ack_attempt_at.lt.${iso(now - ACK_SWEEP_RETRY_GAP_MS)}`)
    .order('last_ack_attempt_at', { ascending: true, nullsFirst: true }).order('created_at', { ascending: true })
    .limit(ACK_SWEEP_BATCH)
  if (error) return { error: error.message }

  const origin = env && env.API_ORIGIN ? String(env.API_ORIGIN).replace(/\/+$/, '') : null
  const out = { examined: (leads || []).length, sent: 0, failed: 0, adopted: 0, suppressed: 0, budgetExhausted: false }
  for (const lead of leads || []) {
    if (await isSuppressed(supabase, lead.email)) { out.suppressed++; continue }
    // The email may have gone out and only the bookkeeping failed: take the log's word for it.
    const earlier = await findEarlierAck(supabase, lead.email, now)
    if (earlier) { await stampLead(env, { id: lead.id }, { last_ack_at: earlier }); out.adopted++; continue }
    const result = await attemptAck(env, lead, { origin })
    if (result.reason === 'budget') { out.budgetExhausted = true; break }
    await stampLead(env, { id: lead.id }, {
      ack_attempts: (lead.ack_attempts || 0) + 1, last_ack_attempt_at: iso(Date.now())
    })
    if (result.sent) out.sent++; else out.failed++
  }
  return out
}

async function findEarlierAck(supabase, email, now) {
  try {
    const { data, error } = await supabase.from('email_logs').select('sent_at')
      .eq('to', email).eq('template', 'employer_lead_ack').eq('status', 'sent')
      .gte('sent_at', new Date(now - NOTIFY_COOLDOWN_MS).toISOString())
      .order('sent_at', { ascending: false }).limit(1)
    if (error || !Array.isArray(data) || !data.length) return null
    return data[0].sent_at
  } catch (_) { return null }
}

module.exports = {
  EMPLOYER_MAIL_TEMPLATES,
  createLead, confirmLead, setLeadField, removeLead, unsubscribeLead, unsubscribeRedirect, adminMarkConfirmed,
  adminListLeads, adminExportLeads, adminCreateLead, adminImportLeads, sweepUnacknowledgedLeads,
  adminUpdateLeadStatus, adminBulkUpdateLeads, adminDeleteLead, adminRequestConfirmation,
  adminCheckSuppression, adminAddSuppression, adminLiftSuppression, adminNotifyCandidates,
  performRemoval,
  LEAD_STATUSES, LEAD_SOURCES
}
