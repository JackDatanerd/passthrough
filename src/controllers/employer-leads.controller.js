const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')
const { leadRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')

// FEATURE GAP CLOSED (Section 5, fixing-time pass): status lifecycle for a
// lead, matching lead_status_enum (migration 0018). Exported for the route
// file's own validation and reused below.
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED']

// Same UUID-format check missing everywhere else in the app (id params are
// otherwise handed straight to `.eq('id', ...)`, and a malformed one blows
// up as an uncaught Postgres type error → generic 500 instead of a clean
// 400). Scoped to this controller's two new id-taking endpoints for now.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Mirrors admin.controller.js's sanitizeSearchTerm — not exported from
// there, so duplicated rather than reaching across controllers for one
// helper. Strips characters that would break PostgREST's `.or()` filter
// string (commas separate conditions, parens group them).
function sanitizeSearchTerm(term) {
  return String(term || '').trim().replace(/[,()]/g, '')
}

// AUDIT FIX (Section 5): all three string fields are now trimmed before
// validation. Previously a trailing space from a copy-pasted email (very
// common) failed z.string().email() outright and surfaced as a generic
// "Validation failed" with no indication why. `company` is also trimmed
// before its min(1) check, since a whitespace-only string was passing
// validation and landing in the DB as blank-looking junk. Email is also
// lowercased so the new uniqueness constraint below (and any future manual
// lookup by email) isn't defeated by casing differences.
// FEATURE GAP CLOSED (Section 5): `source` used to be hardcoded, because
// the public form on Verify.jsx's individual candidate pages was the only
// entry point that existed. Now the homepage's "For employers" section
// (Home.jsx) has its own lead-capture form too, so this needs to tell the
// two apart in the admin list — whitelisted rather than accepting any
// client string, since this only exists for internal reporting and isn't
// something a submitter should be able to set to anything.
const LEAD_SOURCES = ['verification_page', 'homepage']

const schema = z.object({
  name:         z.string().trim().min(1).max(100),
  company:      z.string().trim().min(1).max(200),
  email:        z.string().trim().toLowerCase().email(),
  roleCategory: z.string().trim().max(100).optional(),
  source:       z.enum(LEAD_SOURCES).optional()
})

// POST /api/employer-leads — public, rate-limited.
async function createLead(c) {
  const body = await c.req.json()
  const data = schema.parse(body)
  const supabase = getSupabase(c.env)

  const row = {
    name:          data.name,
    company:       data.company,
    email:         data.email,
    role_category: data.roleCategory || null,
    source:        data.source || 'verification_page'
  }

  const { error: insertErr } = await supabase.from('employer_leads').insert(row)

  if (insertErr) {
    // AUDIT FIX (Section 5): employer_leads.email now has a unique
    // constraint (migration 0013). Previously the same person re-submitting
    // (e.g. from a different candidate's verification page) just silently
    // created a duplicate row — no dedup at all. Rather than reject the
    // resubmission outright, treat it as "update my details" so the lead's
    // company/role stays current instead of the list quietly accumulating
    // stale duplicates.
    if (insertErr.code !== '23505') throw insertErr
    // Deliberately NOT touching `status` here: a resubmission from the
    // public form shouldn't silently reopen a lead an admin already worked
    // through to CONTACTED/CONVERTED, or un-archive one they dismissed as
    // spam. Status is admin-owned, changed only via adminUpdateLeadStatus.
    const { error: updateErr } = await supabase.from('employer_leads').update({
      name: data.name, company: data.company, role_category: data.roleCategory || null,
      updated_at: new Date().toISOString()
    }).eq('email', data.email)
    if (updateErr) throw updateErr
    return c.json({ success: true, message: "We'll be in touch." })
  }

  // AUDIT FIX (Section 5): this was previously a write-only sink — a lead
  // landed in the DB with nothing anywhere to ever surface it short of a
  // manual Supabase query. Only alert on a genuinely NEW lead, not the
  // update-on-resubmit path above. Best-effort, same as every other
  // sendOwnerAlert call in the codebase — a notification failure must never
  // fail the request itself.
  try {
    await emailService.sendOwnerAlert(c.env, 'New employer lead',
      `name: ${data.name}\ncompany: ${data.company}\nemail: ${data.email}\nroleCategory: ${data.roleCategory || '(none)'}`
    )
  } catch (_) {}

  return c.json({ success: true, message: "We'll be in touch." })
}

// GET /api/employer-leads — admin only.
// AUDIT FIX (Section 5): the actual retrieval path this section was missing
// entirely. Mirrors adminListPartners' shape in partners.controller.js.
//
// FEATURE GAP CLOSED (Section 5, fixing-time pass): optional ?status= and
// ?search= filters, mirroring adminListUsers' pattern in admin.controller.js
// (search across name/company/email via `.or()` + ilike). Still unpaginated
// on purpose — see this endpoint's history; volume hasn't changed, only the
// ability to narrow the list has.
async function adminListLeads(c) {
  const supabase = getSupabase(c.env)
  const search = sanitizeSearchTerm(c.req.query('search'))
  const status = c.req.query('status')

  let query = supabase.from('employer_leads').select('*').order('created_at', { ascending: false })
  if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,email.ilike.%${search}%`)
  if (status && LEAD_STATUSES.includes(status)) query = query.eq('status', status)

  const { data, error } = await query
  if (error) throw error

  return c.json({ success: true, data: data.map(leadRowToCamel) })
}

// PATCH /api/employer-leads/:id — admin only.
// FEATURE GAP CLOSED (Section 5, fixing-time pass): the missing lifecycle-
// tracking half of the leads gap. Lets an admin mark a lead CONTACTED /
// CONVERTED / ARCHIVED so the list can actually be worked, not just viewed.
//
// FEATURE GAP CLOSED (Section 5, fixing-time pass): also accepts an
// optional free-text `notes` field (migration 0020) — status alone can't
// record WHY a lead is CONTACTED or ARCHIVED ("left voicemail", "wrong
// industry, not a fit"), and every sibling admin list that tracks lifecycle
// state can carry more context than a bare enum. Either field can be sent
// alone (AdminLeads.jsx's status dropdown and notes field save
// independently) or both together; at least one is required.
const updateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes:  z.string().trim().max(2000).optional()
}).refine(d => d.status !== undefined || d.notes !== undefined, {
  message: 'status or notes required.'
})

async function adminUpdateLeadStatus(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const body = await c.req.json()
  const { status, notes } = updateSchema.parse(body)

  const patch = { updated_at: new Date().toISOString() }
  if (status !== undefined) patch.status = status
  if (notes  !== undefined) patch.notes  = notes || null

  const supabase = getSupabase(c.env)
  const { data, error } = await supabase
    .from('employer_leads')
    .update(patch)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)

  return c.json({ success: true, data: leadRowToCamel(data) })
}

// DELETE /api/employer-leads/:id — admin only.
// FEATURE GAP CLOSED (Section 5, fixing-time pass): no way to remove a
// spam/junk submission short of a manual Supabase query — same gap the
// original retrieval-side fix (adminListLeads, above) closed for reads.
async function adminDeleteLead(c) {
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ success: false, message: 'Invalid lead id.' }, 400)

  const supabase = getSupabase(c.env)
  const { data, error } = await supabase
    .from('employer_leads')
    .delete()
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) return c.json({ success: false, message: 'Lead not found.' }, 404)

  return c.json({ success: true, message: 'Lead deleted.' })
}

module.exports = { createLead, adminListLeads, adminUpdateLeadStatus, adminDeleteLead, LEAD_STATUSES }
