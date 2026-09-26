const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')
const { leadRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')
const constants = require('../config/constants')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { normalizeCode, isPlausibleCode } = require('../lib/verification')
const { isRangeError } = require('../lib/db')
const { sha256 } = require('../lib/crypto')
const { signLeadToken, verifyLeadToken } = require('../lib/leadTokens')
const { logAdminAction } = require('../lib/adminAudit')

// ── Vocabulary ──────────────────────────────────────────────────────────────
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
const INVISIBLE_CHARS = /[\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
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
  website: z.string().nullish()
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

async function readBudgetState(kv, key) {
  const raw = await kv.get(key)
  if (!raw) return { count: 0, refunds: 0 }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.count === 'number')
      return { count: parsed.count, refunds: typeof parsed.refunds === 'number' ? parsed.refunds : 0 }
  } catch (_) { /* fall through */ }
  return { count: parseInt(raw, 10) || 0, refunds: 0 }   // pre-fix value was a bare integer string
}

// Returns { allowed, refund }. `refund` gives back the slot this call just
// consumed if the send it was reserved for turns out to have failed — bound
// to the SAME key the slot was consumed from (not a key re-derived from
// "now" later), so a refund that happens to land right at an hour boundary
// can never touch a different hour's count than the one it actually spent.
async function withinBudget(env, name, max, maxRefunds) {
  const noRefund = async () => {}
  const kv = env.RATE_LIMIT_KV
  if (!kv) return { allowed: true, refund: noRefund }
  const key = `rl:${name}:${Math.floor(Date.now() / 3_600_000)}`
  const { count, refunds } = await readBudgetState(kv, key)
  if (count >= max) return { allowed: false, refund: noRefund }
  await kv.put(key, JSON.stringify({ count: count + 1, refunds }), { expirationTtl: 7200 })
  return {
    allowed: true,
    refund: async () => {
      try {
        const cur = await readBudgetState(kv, key)
        if (cur.count <= 0 || cur.refunds >= maxRefunds) return
        await kv.put(key, JSON.stringify({ count: cur.count - 1, refunds: cur.refunds + 1 }), { expirationTtl: 7200 })
      } catch (err) {
        console.error(`Employer-lead budget (${name}) refund failed:`, err.message)
      }
    }
  }
}

async function sendNotice(env, subject, message) {
  const budget = await withinBudget(env, 'leadnotice', NOTICE_BUDGET_PER_HOUR, NOTICE_MAX_REFUNDS_PER_HOUR)
  if (!budget.allowed) {
    console.warn(`Employer-lead notice budget (${NOTICE_BUDGET_PER_HOUR}/h) exhausted — skipped: ${subject}`)
    return
  }
  try {
    await emailService.sendOwnerNotice(env, subject, message)
  } catch (err) {
    console.error('Employer-lead notice failed:', err.message)
    await budget.refund()
  }
}

const fieldLabel = (cat) => cat ? cat.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) : ''

// The two links every acknowledgement carries. Built here (not in the email
// service) because signing needs the secret and the frontend origin.
async function leadLinks(env, email) {
  const [confirmTok, removeTok] = await Promise.all([
    signLeadToken(env.JWT_SECRET, 'confirm', email),
    signLeadToken(env.JWT_SECRET, 'remove', email)
  ])
  return {
    confirmUrl: `${env.FRONTEND_URL}/employer/confirm?token=${confirmTok}`,
    removeUrl:  `${env.FRONTEND_URL}/employer/remove?token=${removeTok}`
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
async function sendAck(env, row, { skipBudget = false } = {}) {
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
      env, getSupabase(env), row.email, row.name, fieldLabel(row.role_category), await leadLinks(env, row.email))
    if (!sent) await refund()
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
  await runInBackground(c, sendAck(c.env, row))
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

  // Never confirmed and not dismissed: they may simply not have seen the first
  // email, so send it again (capped per recipient in email.service.js).
  if (!existing.confirmed_at && existing.status !== 'ARCHIVED') await runInBackground(c, sendAck(c.env, existing))

  // Worth a heads-up only if it's not a lead the admin dismissed and hasn't
  // already been announced recently (a hiring manager clicking twice isn't news).
  const lastMs = existing.last_submitted_at ? Date.parse(existing.last_submitted_at) : 0
  if (existing.status !== 'ARCHIVED' && now.getTime() - lastMs > RESUBMIT_NOTICE_COOLDOWN_MS) {
    const changed = ['name', 'company'].filter(k => existing[k] !== row[k]).map(k => `${k}: ${row[k]}`)
    await notifyOwner(c, 'Employer lead resubmitted',
      `${describeLead(existing)}\nsubmissions: ${patch.submission_count}` +
      (changed.length ? `\n\nThis time they entered different details (not saved over the lead):\n${changed.join('\n')}` : ''))
  }
  return 'ok'
}

async function createLead(c) {
  const body = await c.req.json()
  const data = schema.parse(body)
  if (data.website) return ok(c)   // honeypot tripped: pretend success, store nothing

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
    status: LEAD_STATUSES.includes(status) ? status : null,
    field:  FIELD_FILTERS.includes(field) ? field : null,
    source: ALL_LEAD_SOURCES.includes(source) ? source : null,
    // yes = the address was confirmed, no = still unconfirmed.
    confirmed: ['yes', 'no'].includes(c.req.query('confirmed')) ? c.req.query('confirmed') : null,
    sort
  }
}

function applyFilters(query, { search, status, field, source, confirmed }) {
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,role_title.ilike.%${search}%`)
  if (status) query = query.eq('status', status)
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
    const { data: rows, error: sErr } = await supabase.rpc('verified_candidate_counts')
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
  for (let from = 0; rows.length < EXPORT_MAX_ROWS; from += EXPORT_CHUNK) {
    const { data, error } = await applySort(
      applyFilters(supabase.from('employer_leads').select('*'), filters), filters.sort
    ).range(from, from + EXPORT_CHUNK - 1)
    if (error) {
      if (isRangeError(error)) break   // ran exactly to the end of the data
      throw error
    }
    rows.push(...data)
    if (data.length < EXPORT_CHUNK) break
  }
  if (rows.length >= EXPORT_MAX_ROWS) console.warn(`Employer-lead export hit the ${EXPORT_MAX_ROWS}-row cap — the file is truncated`)
  // Exporting every lead's name and email is exactly what an audit trail is for.
  await logAdminAction(c, supabase, 'lead.export', 'employer_leads', null, {
    rows: rows.length,
    filters: Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && k !== 'search')),
    searched: !!filters.search
  })
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(',')]
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(r))).join(','))
  return c.body(CSV_BOM + lines.join('\r\n') + '\r\n', 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="employer-leads.csv"'
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
    contacted_at: d.status === 'CONTACTED' ? now : null,
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

  const { data, error } = await supabase.from('employer_leads').insert(row).select().single()
  if (error) {
    if (error.code === '23505')
      return c.json({ success: false, message: 'A lead with that email already exists.' }, 409)
    throw error
  }
  if (suppressed) {
    // Explicitly re-added: lift the suppression so the public form and the
    // acknowledgement flow treat them like any other lead again.
    const { error: liftErr } = await supabase.from('employer_lead_suppressions').delete().eq('email_hash', await sha256(d.email))
    if (liftErr) throw liftErr
  }
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
// contacted_at is stamped the first time a lead reaches CONTACTED.
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
  if (d.status === 'CONTACTED' && !existing.contacted_at) patch.contacted_at = patch.updated_at

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
  if (status === 'CONTACTED') {
    const { error: stampErr } = await supabase
      .from('employer_leads').update({ contacted_at: now }).in('id', ids).is('contacted_at', null)
    if (stampErr) throw stampErr
  }
  await logAdminAction(c, supabase, 'lead.bulk_status', 'employer_lead', null, { status, ids: (data || []).map(r => r.id) })
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
  const email = await verifyLeadToken(c.env.JWT_SECRET, 'confirm', token)
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
  // A confirmed lead is a real one — worth telling the owner.
  await notifyOwner(c, 'Employer lead confirmed', describeLead(lead))
  return c.json({ success: true, status: 'confirmed', message: "Thanks — your email is confirmed. We'll be in touch when there are Verified candidates in your field." })
}

// POST /api/employer-leads/remove { token }
// Records the do-not-contact hash FIRST, then deletes the lead: if the second
// step fails the caller retries and the operation is idempotent, whereas the
// other order could leave a deleted lead the public form re-creates.
async function removeLead(c) {
  const { token } = tokenBodySchema.parse(await c.req.json())
  const email = await verifyLeadToken(c.env.JWT_SECRET, 'remove', token)
  if (!email) return c.json(INVALID_LINK, 400)

  const supabase = getSupabase(c.env)
  const { error: supErr } = await supabase
    .from('employer_lead_suppressions').upsert({ email_hash: await sha256(email) }, { onConflict: 'email_hash', ignoreDuplicates: true })
  if (supErr) throw supErr
  const { error: delErr } = await supabase.from('employer_leads').delete().eq('email', email)
  if (delErr) throw delErr
  return c.json({ success: true, message: "You've been removed. We won't contact you again." })
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
  return c.json({ success: true, data: { suppressed: !!data, since: data?.created_at || null } })
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

  const sent = await sendAck(c.env, lead, { skipBudget: true })
  await logAdminAction(c, supabase, 'lead.request_confirmation', 'employer_lead', id, { sent })
  if (!sent) return c.json({ success: false, message: 'The email was not sent (this address has reached its email limit, or delivery failed). Try again later.' }, 429)
  return c.json({ success: true, message: 'Confirmation email sent.' })
}

module.exports = {
  createLead, confirmLead, removeLead,
  adminListLeads, adminExportLeads, adminCreateLead,
  adminUpdateLeadStatus, adminBulkUpdateLeads, adminDeleteLead, adminRequestConfirmation,
  adminCheckSuppression, adminLiftSuppression,
  LEAD_STATUSES, LEAD_SOURCES
}
