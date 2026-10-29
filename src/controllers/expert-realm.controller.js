// Experts Phase 2A: the expert's own routes in the realm: the Desk (empty shell until the claim queue and workbench ship) and one assigned-job
// read. A job is readable only by the expert it is CURRENTLY assigned to: the API checks it, and the database function human_job_expert_read
// checks it again (and logs the attempt). Every read is written to the realm audit log, and the request fails if that write fails.
const { getSupabase } = require('../config/supabase')
const pilot = require('../lib/humanPilot')
const { audit } = require('../services/expertAudit.service')
const { maskCompany } = require('./expert.controller')

const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const WORKING = ['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision', 'delivered']
const NO_ACCESS = 'You do not have access to this job.'
const deny = (c, status = 403) => c.json({ success: false, message: NO_ACCESS, code: 'NO_ACCESS' }, status)

async function desk(c) {
  const { account } = c.get('xr'); const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('human_jobs').select('id, job_number, state, tier, version, expert_pay_cents, promised_deadline_at, internal_deadline_at')
    .eq('expert_id', account.id).in('state', WORKING).order('internal_deadline_at', { ascending: true })
  if (error) throw error
  return c.json({ success: true, data: { jobs: (data || []).map(j => ({ id: j.id, jobNumber: j.job_number, state: j.state, tier: j.tier, tierLabel: pilot.tierLabel(j.tier), version: j.version,
    payCents: j.expert_pay_cents, dueAt: j.promised_deadline_at, internalDueAt: j.internal_deadline_at })) } })
}

// The brief of an assigned job: what the work is, with the company name masked. The document itself is the workbench's job (Phase 2B).
async function jobBrief(c) {
  const { account, roles } = c.get('xr'); const id = c.req.param('id'); const supabase = getSupabase(c.env)
  if (!isUuid(id)) return deny(c)
  const { data: job } = await supabase.from('human_jobs').select('id, expert_id, state').eq('id', id).maybeSingle()
  if (!job || job.expert_id !== account.id || !WORKING.includes(job.state)) {
    await audit(supabase, { actorId: account.id, roles, action: 'job.read_denied', targetType: 'job', targetId: isUuid(id) ? id : 'invalid' })
    return deny(c)                                                  // the same answer for "not yours" and "does not exist"
  }
  const s = await pilot.loadSettings(supabase); if (!s) return c.json({ success: false, message: 'Not available right now.' }, 503)
  const { data: r, error } = await supabase.rpc('human_job_expert_read', { p_job: id, p_expert: account.id, p_window_days: s.revision_window_days })
  if (error) throw error
  if (!r) return deny(c)                                            // the database refused: it logged the attempt itself
  try { await audit(supabase, { actorId: account.id, roles, action: 'job.brief_read', targetType: 'job', targetId: id, required: true }) }
  catch (_) { return c.json({ success: false, message: 'Not available right now.' }, 503) }     // no log, no read
  const brief = { ...(r.job.brief || {}), jobPosting: maskCompany(r.job.brief && r.job.brief.jobPosting) }
  const { brief: _b, ...meta } = r.job
  return c.json({ success: true, data: { job: { id: meta.id, jobNumber: meta.job_number, state: meta.state, tier: meta.tier, version: meta.version, dueAt: meta.promised_deadline_at }, brief } })
}

module.exports = { desk, jobBrief, WORKING, isUuid }
