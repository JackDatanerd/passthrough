// Experts Phase 2A: the expert admin console's API (job board, timeline, assign / reassign, expert directory, refund, audit viewer).
// Nothing here returns resume text, a customer's contact details or a payment reference. The refund goes through the bridge only.
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const engine = require('../services/humanJobs.service')
const bridge = require('../services/expertBridge.service')
const { audit } = require('../services/expertAudit.service')
const { clockFrom, pausesFromEvents, reconcile } = require('../lib/expertRealm/clock')
const pilot = require('../lib/humanPilot')
const { isUuid, WORKING } = require('./expert-realm.controller')

const bad = (c, message, status = 400, code) => c.json({ success: false, message, ...(code ? { code } : {}) }, status)
const readJson = async c => { try { return await c.req.json() } catch (_) { return {} } }
const STATES = require('../lib/expertRealm/stateMachine').STATES
const EVENT_CAP = 2000

async function board(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env)
  const state = c.req.query('state'); const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100)
  if (state && !STATES.includes(state)) return bad(c, 'Unknown state.', 400)
  const before = c.req.query('before')      // AUDIT A2 (G4): paging. `before` is the nextBefore of the previous page (the created_at of its last job).
  if (before !== undefined && !(typeof before === 'string' && before.length <= 40 && Number.isFinite(Date.parse(before)))) return bad(c, 'Bad page marker.', 400)
  let q = supabase.from('human_jobs').select('id, job_number, state, tier, version, expert_id, promised_deadline_at, internal_deadline_at, paid_at, created_at').order('created_at', { ascending: false }).limit(limit)
  if (state) q = q.eq('state', state)
  if (before) q = q.lt('created_at', new Date(before).toISOString())
  const { data: jobs, error } = await q; if (error) throw error
  const ids = [...new Set((jobs || []).map(j => j.expert_id).filter(Boolean))]
  const { data: experts } = ids.length ? await supabase.from('expert_accounts').select('id, display_first_name, display_initial').in('id', ids) : { data: [] }
  const who = new Map((experts || []).map(e => [e.id, e]))
  const { data: next } = (jobs || []).length ? await supabase.from('job_next_actions').select('job_id, next_action_at, next_action_kind').in('job_id', jobs.map(j => j.id)) : { data: [] }
  const nx = new Map((next || []).map(n => [n.job_id, n]))
  await audit(supabase, { actorId: account.id, roles, action: 'admin.board_view', targetType: 'board', detail: { count: (jobs || []).length, state: state || 'all' } })
  return c.json({ success: true, data: { nextBefore: (jobs || []).length === limit ? jobs[jobs.length - 1].created_at : null, jobs: (jobs || []).map(j => ({ id: j.id, jobNumber: j.job_number, state: j.state, tier: j.tier, version: j.version, dueAt: j.promised_deadline_at,
    expert: j.expert_id && who.get(j.expert_id) ? { id: j.expert_id, firstName: who.get(j.expert_id).display_first_name, initial: who.get(j.expert_id).display_initial } : null,
    nextAction: nx.get(j.id) ? { at: nx.get(j.id).next_action_at, kind: nx.get(j.id).next_action_kind } : null })) } })
}

// One job: state, the actors' timeline (kinds and states only), pauses, the derived clock, what the state machine would allow next.
async function jobDetail(c) {
  const { account, roles } = c.get('xr'); const id = c.req.param('id'); const supabase = getSupabase(c.env)
  if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const unavailable = () => bad(c, 'Not available right now.', 503)      // AUDIT A2 (B5): a failed read is a 503, never an empty answer that looks true
  const { data: job, error: jobErr } = await supabase.from('human_jobs').select('id, job_number, state, tier, version, expert_id, paid_at, promised_deadline_at, internal_deadline_at, paused_seconds, pause_started_at, auto_accept_at, revision_count').eq('id', id).maybeSingle()
  if (jobErr) return unavailable()
  if (!job) return bad(c, 'Not found.', 404)
  const { data: events, error: evErr } = await supabase.from('job_events').select('id, kind, actor_kind, created_at, detail').eq('job_id', id).order('id', { ascending: true }).limit(EVENT_CAP)
  const { data: next, error: nxErr } = await supabase.from('job_next_actions').select('next_action_at, next_action_kind').eq('job_id', id).maybeSingle()
  if (evErr || nxErr) return unavailable()
  const truncated = (events || []).length >= EVENT_CAP      // AUDIT A2 (B8): with the cap hit the pauses are incomplete, so the clock check says "unknown" instead of guessing
  const s = await pilot.loadSettings(supabase)
  const pauses = pausesFromEvents(events || [])
  const hours = s && s.turnaround_hours && s.turnaround_hours[job.tier]
  const buffer = (s && s.internal_buffer_hours && s.internal_buffer_hours[job.tier]) || 0
  const clock = job.paid_at && hours ? clockFrom({ paidAt: job.paid_at, turnaroundHours: hours, bufferHours: buffer, pauses, now: new Date().toISOString() }) : null
  let expert = null
  if (job.expert_id) { const { data: e, error: exErr } = await supabase.from('expert_accounts').select('id, display_first_name, display_initial').eq('id', job.expert_id).maybeSingle(); if (exErr) return unavailable(); if (e) expert = { id: e.id, firstName: e.display_first_name, initial: e.display_initial } }
  await audit(supabase, { actorId: account.id, roles, action: 'admin.job_view', targetType: 'job', targetId: id, required: false })
  return c.json({ success: true, data: {
    job: { id: job.id, jobNumber: job.job_number, state: job.state, tier: job.tier, version: job.version, paidAt: job.paid_at, dueAt: job.promised_deadline_at, autoAcceptAt: job.auto_accept_at, revisionUsed: job.revision_count > 0 },
    expert, nextAction: next ? { at: next.next_action_at, kind: next.next_action_kind } : null, clock, clockMatchesStored: truncated ? null : reconcile(job, pauses, new Date().toISOString()).ok, eventsTruncated: truncated,
    timeline: (events || []).map(e => ({ id: e.id, kind: e.kind, actorKind: e.actor_kind, at: e.created_at, from: e.detail && e.detail.from || null, to: e.detail && e.detail.to || null, trigger: e.detail && e.detail.trigger || null })) } })
}

const assignBody = z.object({ expertId: z.string().uuid(), reason: z.string().trim().min(5).max(300), idemKey: z.string().min(8).max(80).optional(), expectedVersion: z.number().int().min(0).optional() }).strict()      // AUDIT A2 (G4): the console sends the version it was looking at
const assignAs = trigger => async function assignHandler(c) {
  const { account, roles } = c.get('xr'); const id = c.req.param('id'); const supabase = getSupabase(c.env)
  if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const p = assignBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Check the expert and the reason.', 400)
  const r = await engine.assign(supabase, { jobId: id, expertId: p.data.expertId, operatorId: account.id, reason: p.data.reason, idemKey: p.data.idemKey || null, expectedVersion: p.data.expectedVersion ?? null, trigger })
  await audit(supabase, { actorId: account.id, roles, action: r.ok ? `admin.job_${trigger}ed` : `admin.job_${trigger}_refused`, targetType: 'job', targetId: id, detail: { expert: p.data.expertId, result_code: r.ok ? 'ok' : r.code, reason_len: p.data.reason.length } })
  return r.ok ? c.json({ success: true, data: { state: r.state, version: r.version } }) : bad(c, `Not possible: ${r.code}`, r.status || 409, r.code)
}

const refundBody = z.object({ reason: z.string().trim().min(5).max(300), amountCents: z.number().int().positive().optional(), idemKey: z.string().min(8).max(80) }).strict()
async function refund(c) {
  const { account, roles } = c.get('xr'); const id = c.req.param('id'); const supabase = getSupabase(c.env)
  if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const p = refundBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Check the reason, amount and request key.', 400)
  try { await audit(supabase, { actorId: account.id, roles, action: 'money.refund_requested', targetType: 'job', targetId: id, detail: { amount_cents: p.data.amountCents ?? null, reason_len: p.data.reason.length }, required: true }) }
  catch (_) { return bad(c, 'Not available right now.', 503) }          // no log, no money moves
  const r = await bridge.refundHumanOrder(c.env, supabase, { jobId: id, amountCents: p.data.amountCents ?? null, reason: p.data.reason, actorId: account.id, idemKey: p.data.idemKey })
  await audit(supabase, { actorId: account.id, roles, action: r.ok ? 'money.refund_queued' : 'money.refund_refused', targetType: 'job', targetId: id, detail: { result_code: r.ok ? 'ok' : r.code, replay: !!r.replay } })
  return r.ok ? c.json({ success: true, data: { queued: true, replay: !!r.replay, partial: r.partial ?? null } }) : bad(c, r.message || `Not possible: ${r.code}`, r.status >= 400 ? r.status : 409, r.code)      // AUDIT A2 (B2): a refusal is never a 200
}

async function directory(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env)
  const { data: experts, error } = await supabase.from('expert_accounts').select('id, display_first_name, display_initial, status, enabled, roles, totp_enabled_at, last_login_at, created_at').order('created_at', { ascending: true }).limit(200)
  if (error) throw error
  const { data: jobs, error: jobsErr } = await supabase.from('human_jobs').select('expert_id, state').in('state', WORKING).not('expert_id', 'is', null).limit(20000)      // AUDIT A2 (B8): the default row cap (1000) would silently undercount load
  if (jobsErr) throw jobsErr
  const load = {}; for (const j of jobs || []) load[j.expert_id] = (load[j.expert_id] || 0) + 1
  await audit(supabase, { actorId: account.id, roles, action: 'admin.directory_view', targetType: 'directory', detail: { count: (experts || []).length } })
  return c.json({ success: true, data: { experts: (experts || []).map(e => ({ id: e.id, firstName: e.display_first_name, initial: e.display_initial, status: e.status, enabled: e.enabled, roles: e.roles, twoFactor: !!e.totp_enabled_at, lastSignIn: e.last_login_at, activeJobs: load[e.id] || 0 })) } })
}

async function auditLog(c) {
  const { account, roles } = c.get('xr'); const supabase = getSupabase(c.env)
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 200); const before = parseInt(c.req.query('before') || '', 10)
  let q = supabase.from('expert_audit_log').select('id, created_at, actor_kind, actor_id, action, target_type, target_id, detail').order('id', { ascending: false }).limit(limit)
  if (Number.isFinite(before)) q = q.lt('id', before)
  if (c.req.query('action')) q = q.eq('action', String(c.req.query('action')).slice(0, 80))
  if (isUuid(c.req.query('actor'))) q = q.eq('actor_id', c.req.query('actor'))
  const { data, error } = await q; if (error) throw error
  await audit(supabase, { actorId: account.id, roles, action: 'admin.audit_view', targetType: 'audit_log', detail: { count: (data || []).length } })
  return c.json({ success: true, data: { entries: data || [], nextBefore: (data || []).length === limit ? data[data.length - 1].id : null } })
}

module.exports = { board, jobDetail, assign: assignAs('assign'), reassign: assignAs('reassign'), refund, directory, auditLog }
