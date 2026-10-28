'use strict'

// Experts Phase 1: what runs on the EXISTING hourly tick (one gated call in index.js; no new trigger, no change to the scheduler).
//   1. a question nobody answered in time expires and the job carries on
//   2. delivered jobs past the acceptance window are accepted for the customer (one pay row each)
//   3. unpaid orders past their payment window are closed and their data removed
//   4. retention: a finished job's files, working documents and locked values are deleted after the retention period; a deleted account's at once
// Every step is independent and idempotent; a failure in one never skips another. Does nothing while EXPERTS_ENABLED is off.

const pilot = require('../lib/humanPilot')
const { getSupabase } = require('../config/supabase')

// Remove everything that could identify the customer from one job. The job row, its events and its earnings stay (no resume text in them).
async function purgeJob(env, supabase, jobId) {
  const { data: dels } = await supabase.from('job_deliveries').select('id, files').eq('job_id', jobId)
  const { data: mats } = await supabase.from('job_materials').select('id, original_object_key').eq('job_id', jobId)
  const keys = []
  for (const d of dels || []) for (const k of Object.values(d.files || {})) if (typeof k === 'string') keys.push(k)
  for (const m of mats || []) if (m.original_object_key) keys.push(m.original_object_key)
  if (keys.length) {
    const r = await require('../lib/r2').deleteObjects(env, keys, 'human-purge')
    if (r.failed.length) return { ok: false, failed: r.failed.length }          // keep the rows: the next run retries
  }
  for (const [table, col] of [['job_documents', 'job_id'], ['job_locked_values', 'job_id'], ['job_questions', 'job_id']]) {
    const { error } = await supabase.from(table).delete().eq(col, jobId); if (error) throw error
  }
  await supabase.from('job_materials').update({ status: 'removed', extracted_masked_text: null, link_url: null, original_object_key: null }).eq('job_id', jobId)
  await supabase.from('job_deliveries').update({ files: {}, diff: null, report: null }).eq('job_id', jobId)
  await supabase.from('human_jobs').update({ purged_at: new Date().toISOString(), brief: {}, revision_reason: null }).eq('id', jobId)
  await supabase.from('job_events').insert({ job_id: jobId, kind: 'purged', actor_kind: 'system', detail: {} })
  return { ok: true }
}

async function step(name, fn, out) { try { out[name] = await fn() } catch (err) { console.error(`humanSweep ${name}:`, err.message); out[name] = { error: err.message } } }

async function runHumanSweep(env, { now = Date.now() } = {}) {
  const out = {}
  if (!pilot.humanEnabled(env)) return { skipped: true }
  const supabase = getSupabase(env)
  const s = await pilot.loadSettings(supabase)
  if (!s) return { skipped: true, reason: 'no settings' }

  await step('questions', async () => { const { data, error } = await supabase.rpc('human_job_expire_questions'); if (error) throw error; return data }, out)
  await step('autoAccepted', async () => { const { data, error } = await supabase.rpc('human_job_auto_accept_due', { p_hold_days: s.earnings_hold_days }); if (error) throw error; return data }, out)

  await step('unpaid', async () => {
    const before = new Date(now - (s.pending_expiry_hours || 24) * 3600e3).toISOString()
    const { data: jobs, error } = await supabase.from('human_jobs').select('id, payment_id').eq('state', 'awaiting_payment').lt('created_at', before).limit(100)
    if (error) throw error
    let closed = 0
    for (const j of jobs || []) {
      const { data: pay } = await supabase.from('payments').select('id, status').eq('id', j.payment_id).maybeSingle()
      if (pay && !['PENDING', 'ABANDONED', 'FAILED'].includes(pay.status)) continue      // paid after all: settlement will move it
      await supabase.from('payments').update({ status: 'ABANDONED' }).eq('id', j.payment_id).eq('status', 'PENDING')
      const { data: r } = await supabase.rpc('human_job_reverse', { p_job: j.id, p_reason: 'unpaid: payment window passed' })
      if (r && r.ok) { await purgeJob(env, supabase, j.id); closed++ }
    }
    return closed
  }, out)

  await step('retention', async () => {
    const cutoff = new Date(now - (s.retention_drafts_days || 90) * 86400e3).toISOString()
    const { data: done, error } = await supabase.from('human_jobs').select('id').in('state', ['accepted', 'refunded', 'cancelled']).is('purged_at', null).lt('updated_at', cutoff).limit(50)
    if (error) throw error
    const { data: gone } = await supabase.from('human_jobs').select('id, customer_user_id, state').is('purged_at', null).in('state', ['accepted', 'refunded', 'cancelled', 'delivered']).limit(500)
    let ids = (done || []).map(j => j.id)
    if (gone && gone.length) {
      const { data: users } = await supabase.from('users').select('id, deleted_at').in('id', [...new Set(gone.map(g => g.customer_user_id))])
      const deleted = new Set((users || []).filter(u => u.deleted_at).map(u => u.id))
      ids = [...new Set([...ids, ...gone.filter(g => deleted.has(g.customer_user_id) && g.state !== 'delivered').map(g => g.id)])]
    }
    let n = 0
    for (const id of ids) { const r = await purgeJob(env, supabase, id); if (r.ok) n++ }
    return n
  }, out)
  return out
}

module.exports = { runHumanSweep, purgeJob }
