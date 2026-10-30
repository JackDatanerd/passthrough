// Experts Phase 2A: the job engine's JavaScript half. transition() is the ONLY place the realm moves a job between states. It asks the
// state machine table (lib/expertRealm/stateMachine.js) first, then calls human_job_transition (migration 0127), which re-checks the same
// rules inside one transaction, applies the side effects and writes the event. A caller never writes human_jobs.state itself.
const SM = require('../lib/expertRealm/stateMachine')
const { loadSettings } = require('../lib/humanPilot')

const STATE_COLS = 'id, state, version, expert_id, customer_user_id, tier, created_at, paid_at'
// Moves that decide nothing from settings (stopping, refunding, cancelling, disputing) must still work when the settings row is missing or bad.
const NO_SETTINGS = new Set(['customer_cancel', 'admin_cancel', 'payment_reversed', 'refund', 'dispute', 'dispute_dismissed'])

const ERR_STATUS = { NOT_FOUND: 404, ILLEGAL_TRANSITION: 409, VERSION_CONFLICT: 409, NOT_ASSIGNED: 403, NOT_OWNER: 403, EXPERT_REQUIRED: 400,
  NOT_ELIGIBLE: 409, TWO_FACTOR_MISSING: 409, AGREEMENT_MISSING: 409, CAP: 409, SAME_EXPERT: 400, REVISION_USED: 409, CONSTRAINT: 409,
  IDEM_KEY_MISMATCH: 409, ACTOR_MISMATCH: 403, NOT_GRADER: 403, WINDOW_CLOSED: 409, REVIEW_REQUIRED: 409, NOT_DUE: 409, NO_PENDING_QUESTION: 409,
  BAD_ANSWER: 400, BAD_QUESTION: 400, QUESTION_LIMIT: 409, BAD_REASON: 400, NOT_DELIVERED: 409, AUTO_ACCEPT_REQUIRED: 400, DELIVERY_REQUIRED: 400, NOTHING_SAVED: 409 }

// payload: ask_question { body, options, answerHours } | answered { answer } | request_revision { reason }   (written into the database, never into events)
// delivery: for rescan_passed / redeliver { files, scoreBefore, scoreAfter, report, diff, confirmations, summary, note } -- written in the same transaction.
// actor: { kind: 'system'|'expert'|'customer'|'operator', id, role? }. detail: identifiers and counts only (never resume text).
async function transition(supabase, { jobId, to, trigger, actor, expectedVersion = null, expertId = null, detail = {}, idemKey = null, eventKind = null, promisedAt = null, internalAt = null, payload = null, delivery = null, now = Date.now() }) {
  const { data: job, error } = await supabase.from('human_jobs').select(STATE_COLS).eq('id', jobId).maybeSingle()
  if (error) throw error
  if (!job) return { ok: false, code: 'NOT_FOUND', status: 404 }
  const verdict = SM.check({ from: job.state, to, trigger, actorKind: actor.kind })
  if (!verdict.ok) return { ok: false, code: verdict.code, status: 409, state: job.state }

  let s = await loadSettings(supabase)
  if (!s && NO_SETTINGS.has(trigger)) s = {}
  if (!s) return { ok: false, code: 'SETTINGS_MISSING', status: 503, state: job.state }     // fail closed: no money or deadline rule is guessed
  const rev = s.revision_hours || {}
  const { data, error: rpcErr } = await supabase.rpc('human_job_transition', {
    p_job: jobId, p_to: to, p_trigger: trigger, p_actor_kind: actor.kind, p_actor: actor.id || null,
    p_expected_version: expectedVersion, p_expert: expertId,
    p_event_kind: eventKind, p_detail: { ...detail, ...(actor.role ? { role: actor.role } : {}) }, p_idem_key: idemKey,
    p_hold_days: Number.isInteger(s.earnings_hold_days) ? s.earnings_hold_days : 3,
    p_auto_accept_at: to === 'delivered' ? new Date(now + s.accept_auto_hours * 3600e3).toISOString() : null,
    p_max_active: s.concurrent_cap || 2, p_promised: promisedAt, p_internal: internalAt,
    p_payload: payload ? { body: payload.body, options: payload.options, answer_hours: payload.answerHours, answer: payload.answer, reason: payload.reason } : {},
    p_delivery: delivery ? { files: delivery.files, score_before: delivery.scoreBefore, score_after: delivery.scoreAfter, report: delivery.report, diff: delivery.diff,
      confirmations: delivery.confirmations, summary: delivery.summary, note: delivery.note } : null,
    p_give_back_minutes: s.give_back_window_minutes || 60, p_revision_window_days: Number.isInteger(s.revision_window_days) ? s.revision_window_days : 7,
    p_revision_hours: (job.tier === 'twenty_four_hour' ? rev.twenty_four_hour : rev.other) || 48, p_question_max: s.question_max || 3,
    p_expiry_hours: s.pending_expiry_hours || 24, p_answer_hours: s.question_answer_hours || 24,
  })
  if (rpcErr) throw rpcErr
  if (!data || !data.ok) return { ok: false, code: data ? data.code : 'CONSTRAINT', status: ERR_STATUS[data && data.code] || 409, state: data && data.state }
  return { ok: true, replay: !!data.replay, state: data.state, version: data.version, eventId: data.event_id || null }
}

// The operator moves a job to an expert. trigger: 'assign' (from offered / open) or 'reassign' (from a working state); the state machine
// refuses the wrong pairing, so the two console actions cannot be swapped.
const assign = (supabase, { jobId, expertId, operatorId, reason, idemKey, expectedVersion = null, trigger = 'assign' }) =>
  transition(supabase, { jobId, to: 'claimed', trigger, actor: { kind: 'operator', id: operatorId }, expertId, expectedVersion, detail: { reason_code: `operator_${trigger}`, reason_len: (reason || '').length }, idemKey })

module.exports = { transition, assign, ERR_STATUS }
