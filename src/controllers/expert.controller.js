// Experts Phase 1: the pilot expert's workbench API. Every read of a client's content goes through the database function
// human_job_expert_read and every write through human_job_expert_save: both refuse (and log the attempt) unless the job is assigned
// to this expert and in a working state. The server, not the browser, is the lock: a save is validated against the document the expert
// started from, so a locked contact field, a read-only anchor or a typed contact detail never reaches the database.
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const pilot = require('../lib/humanPilot')
const locks = require('../lib/humanLocks')
const { diffDocuments } = require('../lib/humanDiff')
const { maskCompany, loadMaskContext, presentForExpert } = require('../lib/expertView')

const bad = (c, message, status = 400, extra = {}) => c.json({ success: false, message, ...extra }, status)
const readJson = async c => { try { return await c.req.json() } catch (_) { return undefined } }
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const NO_ACCESS = 'You do not have access to this job.'

const JOB_LIST_COLS = 'id, job_number, state, tier, add_cover_letter, expert_pay_cents, promised_deadline_at, internal_deadline_at, revision_count, revision_due_at, claimed_at'
async function listJobs(c) {
  const e = c.get('expert')
  const { data, error } = await getSupabase(c.env).from('human_jobs').select(JOB_LIST_COLS)
    .eq('expert_id', e.id).in('state', ['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision', 'delivered']).order('internal_deadline_at', { ascending: true })
  if (error) throw error
  return c.json({ success: true, data: { jobs: (data || []).map(j => ({ id: j.id, jobNumber: j.job_number, state: j.state, tier: j.tier, tierLabel: pilot.tierLabel(j.tier), coverLetter: j.add_cover_letter,
    payCents: j.expert_pay_cents, dueAt: j.promised_deadline_at, internalDueAt: j.internal_deadline_at, revision: j.revision_count > 0, revisionDueAt: j.revision_due_at })) } })
}

async function getJob(c) {
  const e = c.get('expert'); const id = c.req.param('id')
  if (!isUuid(id)) return bad(c, NO_ACCESS, 403)
  const supabase = getSupabase(c.env)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(c, 'Not available right now.', 503)
  const { data: r, error } = await supabase.rpc('human_job_expert_read', { p_job: id, p_expert: e.id, p_window_days: s.revision_window_days })
  if (error) throw error
  if (!r) return bad(c, NO_ACCESS, 403)
  const base = r.ai_draft || r.source
  const working = r.working || { version: 0, body: base, cover_letter: null }
  const { brief: _b, ...rawJob } = r.job
  const ctx = await loadMaskContext(c.env, supabase, id)
  const view = presentForExpert({ job: rawJob, brief: r.job.brief, questions: r.questions, materials: r.materials }, ctx)
  return c.json({ success: true, data: { job: view.job, brief: view.brief, document: { version: working.version, body: working.body, coverLetter: working.cover_letter },
    readOnly: locks.readOnlyPaths(base), baseline: base, changes: diffDocuments(base, working.body), questions: view.questions, materials: view.materials,
    askLimit: s.question_max || 3, canEdit: ['claimed', 'in_progress', 'revision'].includes(r.job.state) } })
}

const saveBody = z.object({ baseVersion: z.number().int().min(0), body: z.record(z.any()), coverLetter: z.object({ text: z.string().max(8000) }).nullable().optional(), seconds: z.number().int().min(0).max(3600).optional() }).strict()
// a cover letter is plain text: no contact detail typed in, and only markers the starting letter already had
function validateCover(base, next) {
  const errors = []
  const baseText = base && typeof base.text === 'string' ? base.text : ''
  if (next.text !== baseText && locks.hasContact(next.text)) errors.push({ path: 'coverLetter', code: 'CONTACT_IN_TEXT' })
  const bc = locks.markerCounts(baseText), nc = locks.markerCounts(next.text)
  for (const [m, n] of Object.entries(nc)) { if (!Object.prototype.hasOwnProperty.call(bc, m)) errors.push({ path: m, code: 'UNKNOWN_MARKER' }); else if (n > bc[m]) errors.push({ path: m, code: 'MARKER_DUPLICATED' }) }
  return errors
}

async function saveDocument(c) {
  const e = c.get('expert'); const id = c.req.param('id')
  if (!isUuid(id)) return bad(c, NO_ACCESS, 403)
  const p = saveBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'That document could not be read.')
  const supabase = getSupabase(c.env)
  const { data: start, error: be } = await supabase.rpc('human_job_expert_baseline', { p_job: id, p_expert: e.id })
  if (be) throw be
  if (!start) return bad(c, NO_ACCESS, 403)
  const v = locks.validateEdit(start.body, p.data.body)
  // the cover letter is bound to what was ordered: no letter on a job that did not buy one, and a letter that exists is never dropped by a save that leaves it out
  const coverErrors = []
  if (start.cover_letter == null && p.data.coverLetter) coverErrors.push({ path: 'coverLetter', code: 'COVER_NOT_ORDERED' })
  else if (start.cover_letter != null && !p.data.coverLetter) coverErrors.push({ path: 'coverLetter', code: 'COVER_MISSING' })
  else if (p.data.coverLetter) coverErrors.push(...validateCover(start.cover_letter, p.data.coverLetter))
  const errors = [...v.errors, ...coverErrors]
  if (errors.length) return bad(c, 'Some of that cannot be saved: locked details and read-only lines cannot be changed, and contact details cannot be typed into the text.', 422, { errors })
  const { data, error } = await supabase.rpc('human_job_expert_save', { p_job: id, p_expert: e.id, p_base_version: p.data.baseVersion, p_body: p.data.body, p_cover: p.data.coverLetter || null, p_seconds: p.data.seconds || 0 })
  if (error) throw error
  if (!data.ok) return bad(c, data.reason === 'conflict' ? 'This document changed in another window. Reload it before editing.' : data.reason === 'bad_request' ? 'That document could not be read.' : NO_ACCESS, data.reason === 'conflict' ? 409 : data.reason === 'bad_request' ? 400 : 403, { current: data.current_version })
  return c.json({ success: true, data: { version: data.version } })
}

const askBody = z.object({ body: z.string().trim().min(5).max(600) }).strict()
async function askQuestion(c) {
  const e = c.get('expert'); const id = c.req.param('id'); if (!isUuid(id)) return bad(c, NO_ACCESS, 403)
  const p = askBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Write the question in a sentence or two (up to 600 characters).')
  if (locks.hasContact(p.data.body)) return bad(c, 'Questions cannot contain contact details.', 422)
  const supabase = getSupabase(c.env)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(c, 'Not available right now.', 503)
  const { data, error } = await supabase.rpc('human_job_ask', { p_job: id, p_expert: e.id, p_body: p.data.body, p_options: null, p_answer_hours: s.question_answer_hours || 24, p_max: s.question_max || 3 })
  if (error) throw error
  if (!data.ok) return bad(c, data.reason === 'limit' ? 'You have used the questions this job allows.' : data.reason === 'not_allowed' ? 'A question can be asked while you are working on a job.' : 'That question cannot be sent.', data.reason === 'limit' ? 409 : 403)
  // tell the customer (best effort): the clock has stopped and they need to answer
  try {
    const { data: j } = await supabase.from('human_jobs').select('job_number, customer_user_id').eq('id', id).maybeSingle()
    const { data: u } = j ? await supabase.from('users').select('email, name').eq('id', j.customer_user_id).maybeSingle() : { data: null }
    if (u) await require('../services/email.service').sendHumanQuestion(c.env, supabase, u.email, u.name, { jobNumber: j.job_number, answerHours: s.question_answer_hours || 24 })
  } catch (err) { console.error('expert question notice:', err.message) }
  return c.json({ success: true, data: { seq: data.seq } })
}

async function submitJob(c) {
  const e = c.get('expert'); const id = c.req.param('id'); if (!isUuid(id)) return bad(c, NO_ACCESS, 403)
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.rpc('human_job_submit', { p_job: id, p_expert: e.id })
  if (error) throw error
  if (!data.ok) return bad(c, data.reason === 'nothing_saved' ? 'Save your work before sending it for review.' : NO_ACCESS, data.reason === 'nothing_saved' ? 409 : 403)
  try { await require('../services/email.service').sendOwnerNotice(c.env, 'A job is ready for your review', `An expert submitted a job. Open Admin > Human orders and review it before it goes to the customer.\njob id: ${id}`) } catch (err) { console.error('expert submit notice:', err.message) }
  return c.json({ success: true })
}

module.exports = { listJobs, getJob, saveDocument, askQuestion, submitJob, maskCompany, validateCover }
