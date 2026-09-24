const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')
const { leadRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')
const constants = require('../config/constants')
const { UUID_RE } = require('../middleware/validateUuidParam')
const { normalizeCode, isPlausibleCode } = require('../lib/verification')
const { isRangeError } = require('../lib/db')

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
  source:       z.enum(LEAD_SOURCES).optional(),
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
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_')
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
// The submitter gets ONE acknowledgement, and only for a brand-new lead: it
// confirms the request landed, tells them how to be removed, and makes a
// mistyped address visible (it bounces in the mail log). The form is public,
// so the recipient can be anyone — hence: new leads only (a resubmission never
// re-sends), a per-recipient monthly cap in email.service.js, and its own
// hourly budget here.
const NOTICE_BUDGET_PER_HOUR = 20
const ACK_BUDGET_PER_HOUR = 30
const RESUBMIT_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000

async function withinBudget(env, name, max) {
  const kv = env.RATE_LIMIT_KV
  if (!kv) return true
  const key = `rl:${name}:${Math.floor(Date.now() / 3_600_000)}`
  const used = parseInt(await kv.get(key), 10) || 0
  if (used >= max) return false
  await kv.put(key, String(used + 1), { expirationTtl: 7200 })
  return true
}

async function sendNotice(env, subject, message) {
  try {
    if (!(await withinBudget(env, 'leadnotice', NOTICE_BUDGET_PER_HOUR))) {
      console.warn(`Employer-lead notice budget (${NOTICE_BUDGET_PER_HOUR}/h) exhausted — skipped: ${subject}`)
      return
    }
    await emailService.sendOwnerNotice(env, subject, message)
  } catch (err) {
    console.error('Employer-lead notice failed:', err.message)
  }
}

const fieldLabel = (cat) => cat ? cat.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) : ''

async function sendAck(env, row) {
  try {
    if (!(await withinBudget(env, 'leadack', ACK_BUDGET_PER_HOUR))) {
      console.warn(`Employer-lead acknowledgement budget (${ACK_BUDGET_PER_HOUR}/h) exhausted — skipped`)
      return
    }
    await emailService.sendEmployerLeadAck(env, getSupabase(env), row.email, row.name, fieldLabel(row.role_category))
  } catch (err) {
    console.error('Employer-lead acknowledgement failed:', err.message)
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

// POST /api/employer-leads — public, rate-limited.
//
// Resubmissions (same email) never rewrite what's already on the lead: the
// endpoint is unauthenticated, so letting a repeat submission overwrite
// name/company/role would let anyone who knows an employer's address rewrite
// that lead — and it used to wipe role_category whenever the optional field
// was left blank. A repeat only fills fields that are still empty, and is
// recorded (count + timestamp) so the admin list can show the lead is
// re-engaged. Status stays admin-owned.
async function createLead(c) {
  const body = await c.req.json()
  const data = schema.parse(body)
  if (data.website) return ok(c)   // honeypot tripped: pretend success, store nothing

  const supabase = getSupabase(c.env)
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

  const { error: insertErr } = await supabase.from('employer_leads').insert(row)
  if (!insertErr) {
    await announceNewLead(c, row)
    return ok(c)
  }
  if (insertErr.code !== '23505') throw insertErr

  // Already a lead.
  const { data: existing, error: selErr } = await supabase
    .from('employer_leads').select('*').eq('email', row.email).maybeSingle()
  if (selErr) throw selErr

  if (!existing) {
    // Deleted by an admin between our insert and this read — treat as new
    // rather than reporting success for a lead that no longer exists.
    const { error: retryErr } = await supabase.from('employer_leads').insert(row)
    if (retryErr && retryErr.code !== '23505') throw retryErr
    if (!retryErr) await announceNewLead(c, row)
    return ok(c)
  }

  const now = new Date()
  const patch = {
    submission_count:  (existing.submission_count || 1) + 1,
    last_submitted_at: now.toISOString(),
    updated_at:        now.toISOString()
  }
  if (!existing.role_category     && row.role_category)     patch.role_category     = row.role_category
  if (!existing.role_title        && row.role_title)        patch.role_title        = row.role_title
  if (!existing.source_code && row.source_code) patch.source_code = row.source_code

  const { data: updated, error: updErr } = await supabase
    .from('employer_leads').update(patch).eq('id', existing.id).select('id').maybeSingle()
  if (updErr) throw updErr
  if (!updated) {
    // Deleted after we read it. Same as above: don't lose the submission.
    const { error: retryErr } = await supabase.from('employer_leads').insert(row)
    if (retryErr && retryErr.code !== '23505') throw retryErr
    if (!retryErr) await announceNewLead(c, row)
    return ok(c)
  }

  // Worth a heads-up only if it's not a lead the admin dismissed and hasn't
  // already been announced recently (a hiring manager clicking twice isn't news).
  const lastMs = existing.last_submitted_at ? Date.parse(existing.last_submitted_at) : 0
  if (existing.status !== 'ARCHIVED' && now.getTime() - lastMs > RESUBMIT_NOTICE_COOLDOWN_MS) {
    const changed = ['name', 'company'].filter(k => existing[k] !== row[k]).map(k => `${k}: ${row[k]}`)
    await notifyOwner(c, 'Employer lead resubmitted',
      `${describeLead(existing)}\nsubmissions: ${patch.submission_count}` +
      (changed.length ? `\n\nThis time they entered different details (not saved over the lead):\n${changed.join('\n')}` : ''))
  }
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

function parseFilters(c) {
  const status = c.req.query('status')
  const field  = c.req.query('field')
  const sort   = c.req.query('sort') === 'activity' ? 'activity' : 'created'
  return {
    search: sanitizeSearchTerm(c.req.query('search')),
    status: LEAD_STATUSES.includes(status) ? status : null,
    field:  FIELD_FILTERS.includes(field) ? field : null,
    sort
  }
}

function applyFilters(query, { search, status, field }) {
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%,role_title.ilike.%${search}%`)
  if (status) query = query.eq('status', status)
  if (field === 'none') query = query.is('role_category', null)
  else if (field) query = query.eq('role_category', field)
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

  // Verified-candidate supply per field. Optional garnish: if the migration
  // that defines it hasn't run, the list must still load.
  let supply = null
  try {
    const { data: rows, error: sErr } = await supabase.rpc('verified_candidate_counts')
    if (!sErr && Array.isArray(rows))
      supply = Object.fromEntries(rows.map(r => [r.role_category, Number(r.candidate_count)]))
  } catch (_) { supply = null }

  return c.json({ success: true, data: (data || []).map(leadRowToCamel),
    meta: { page, pageSize, total: count || 0, counts, candidateSupply: supply } })
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
  ['Last submitted', r => r.last_submitted_at], ['Contacted at', r => r.contacted_at]
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
  status:       z.enum(LEAD_STATUSES).optional()
})

async function adminCreateLead(c) {
  const d = manualSchema.parse(await c.req.json())
  const supabase = getSupabase(c.env)
  const now = new Date().toISOString()
  const row = {
    name: d.name, company: d.company, email: d.email,
    role_category: d.roleCategory || null, role_title: d.roleTitle || null,
    notes: d.notes || null, status: d.status || 'NEW', source: 'manual',
    contacted_at: d.status === 'CONTACTED' ? now : null
  }
  const { data, error } = await supabase.from('employer_leads').insert(row).select().single()
  if (error) {
    if (error.code === '23505')
      return c.json({ success: false, message: 'A lead with that email already exists.' }, 409)
    throw error
  }
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
  return c.json({ success: true, message: 'Lead deleted.' })
}

module.exports = {
  createLead, adminListLeads, adminExportLeads, adminCreateLead,
  adminUpdateLeadStatus, adminBulkUpdateLeads, adminDeleteLead,
  LEAD_STATUSES, LEAD_SOURCES
}
