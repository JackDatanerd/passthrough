const { z }  = require('zod')
const { getSupabase } = require('../config/supabase')
const { leadRowToCamel } = require('../lib/mappers')
const emailService = require('../services/email.service')

// AUDIT FIX (Section 5): all three string fields are now trimmed before
// validation. Previously a trailing space from a copy-pasted email (very
// common) failed z.string().email() outright and surfaced as a generic
// "Validation failed" with no indication why. `company` is also trimmed
// before its min(1) check, since a whitespace-only string was passing
// validation and landing in the DB as blank-looking junk. Email is also
// lowercased so the new uniqueness constraint below (and any future manual
// lookup by email) isn't defeated by casing differences.
const schema = z.object({
  name:         z.string().trim().min(1).max(100),
  company:      z.string().trim().min(1).max(200),
  email:        z.string().trim().toLowerCase().email(),
  roleCategory: z.string().trim().max(100).optional()
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
    source:        'verification_page'
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
async function adminListLeads(c) {
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase
    .from('employer_leads')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error

  return c.json({ success: true, data: data.map(leadRowToCamel) })
}

module.exports = { createLead, adminListLeads }
