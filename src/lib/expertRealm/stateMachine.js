// Experts Phase 2A: the state machine's TABLE and its pure helpers. This file is the JavaScript half of the single state machine; the
// database half is human_job_transition (migration 0127), which checks the same rules from job_transition_rules. A test parses the
// migration and fails if the two tables ever differ. Nothing here talks to the database or the clock: services/humanJobs.service.js
// is the only caller that applies a transition, and everything that wants to know "may this happen?" asks this module.
//
// Actor kinds are the job_events kinds: system, expert, customer, operator. A grader acts as 'expert' in events (the role is in the detail).

const STATES = Object.freeze(['awaiting_payment', 'offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks',
  'delivered', 'revision', 'accepted', 'disputed', 'refunded', 'cancelled'])
const TERMINAL = Object.freeze(['refunded', 'cancelled'])
// a job has an expert if and only if it is in one of these states (engineering spec 5.1)
const CARRYING = Object.freeze(['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted'])
const ACTOR_KINDS = Object.freeze(['system', 'expert', 'customer', 'operator'])

// [from, to, trigger, actors] -- keep in the same order as the seed in supabase/migrations/0127_experts_phase2a_realm.sql
const RULES = Object.freeze([
  ['awaiting_payment', 'offered', 'payment_confirmed', ['system']],
  ['awaiting_payment', 'cancelled', 'expired', ['system']],
  ['awaiting_payment', 'cancelled', 'customer_cancel', ['customer']],
  ['awaiting_payment', 'cancelled', 'admin_cancel', ['operator']],
  ['offered', 'cancelled', 'customer_cancel', ['customer']],
  ['offered', 'cancelled', 'admin_cancel', ['operator']],
  ['offered', 'cancelled', 'payment_reversed', ['system']],
  ['open', 'cancelled', 'customer_cancel', ['customer']],
  ['open', 'cancelled', 'admin_cancel', ['operator']],
  ['open', 'cancelled', 'payment_reversed', ['system']],
  ['offered', 'open', 'cascade_widen', ['system']],
  ['offered', 'claimed', 'take', ['expert']],
  ['open', 'claimed', 'take', ['expert']],
  ['offered', 'claimed', 'assign', ['operator']],
  ['open', 'claimed', 'assign', ['operator']],
  ['claimed', 'offered', 'give_back_in_window', ['expert']],
  ['claimed', 'open', 'give_back_in_window', ['expert']],
  ['claimed', 'open', 'give_back_late', ['expert']],
  ['in_progress', 'open', 'give_back_late', ['expert']],
  ['claimed', 'open', 'auto_release', ['system']],
  ['in_progress', 'open', 'auto_release', ['system']],
  ['claimed', 'open', 'unassign', ['operator']],
  ['in_progress', 'open', 'unassign', ['operator']],
  ['claimed', 'claimed', 'reassign', ['operator']],
  ['in_progress', 'claimed', 'reassign', ['operator']],
  ['waiting_customer', 'claimed', 'reassign', ['operator']],
  ['claimed', 'in_progress', 'first_save', ['expert']],
  ['in_progress', 'waiting_customer', 'ask_question', ['expert']],
  ['waiting_customer', 'in_progress', 'answered', ['customer']],
  ['waiting_customer', 'in_progress', 'question_timeout', ['system']],
  ['in_progress', 'in_review', 'submit_review', ['expert']],
  ['revision', 'in_review', 'submit_review', ['expert']],
  ['in_progress', 'final_checks', 'deliver', ['expert']],
  ['in_review', 'final_checks', 'review_approved', ['operator']],
  ['in_review', 'in_progress', 'sent_back', ['operator']],
  ['final_checks', 'delivered', 'rescan_passed', ['system']],
  ['final_checks', 'in_progress', 'rescan_failed', ['system']],
  ['delivered', 'accepted', 'accept', ['customer']],
  ['delivered', 'accepted', 'auto_accept', ['system']],
  ['delivered', 'revision', 'request_revision', ['customer']],
  ['revision', 'delivered', 'redeliver', ['expert']],
  ['claimed', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['in_progress', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['waiting_customer', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['in_review', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['final_checks', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['delivered', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['revision', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['accepted', 'disputed', 'dispute', ['customer', 'expert', 'operator']],
  ['claimed', 'refunded', 'refund', ['operator', 'system']],
  ['in_progress', 'refunded', 'refund', ['operator', 'system']],
  ['waiting_customer', 'refunded', 'refund', ['operator', 'system']],
  ['in_review', 'refunded', 'refund', ['operator', 'system']],
  ['final_checks', 'refunded', 'refund', ['operator', 'system']],
  ['delivered', 'refunded', 'refund', ['operator', 'system']],
  ['revision', 'refunded', 'refund', ['operator', 'system']],
  ['accepted', 'refunded', 'refund', ['operator', 'system']],
  ['disputed', 'refunded', 'refund', ['operator', 'system']],
].map(([from, to, trigger, actors]) => Object.freeze({ from, to, trigger, actors: Object.freeze(actors) })))

const findRule = (from, to, trigger) => RULES.find(r => r.from === from && r.to === to && r.trigger === trigger) || null

// May `actorKind` move a job from `from` to `to` on `trigger`? One place, used by experts, customers, the scheduler and operators alike.
function check({ from, to, trigger, actorKind }) {
  const rule = findRule(from, to, trigger)
  if (!rule || !rule.actors.includes(actorKind)) return { ok: false, code: 'ILLEGAL_TRANSITION' }
  return { ok: true, rule }
}

// Every trigger an actor kind may use from a state (the console and the tracker read this instead of hard-coding buttons).
const triggersFrom = (from, actorKind) => RULES.filter(r => r.from === from && r.actors.includes(actorKind)).map(r => ({ trigger: r.trigger, to: r.to }))

// Does a state hold an expert? (the invariant the database also enforces)
const holdsExpert = state => CARRYING.includes(state)

// The one scheduled thing a job is waiting for, by state. Data only in Phase 2A: the minute trigger that acts on it is not built here.
// ctx: { createdAt, internalDeadlineAt, autoAcceptAt, answerDeadlineAt, pendingExpiryHours }
function nextActionFor(state, ctx = {}) {
  const at = v => (v ? new Date(v).toISOString() : null)
  switch (state) {
    case 'awaiting_payment': { if (!ctx.createdAt) return null; const h = Number.isFinite(ctx.pendingExpiryHours) ? ctx.pendingExpiryHours : 24
      return { at: new Date(new Date(ctx.createdAt).getTime() + h * 3600e3).toISOString(), kind: 'expire_unpaid' } }
    case 'claimed': case 'in_progress': case 'revision': return ctx.internalDeadlineAt ? { at: at(ctx.internalDeadlineAt), kind: 'deadline_warning' } : null
    case 'waiting_customer': return ctx.answerDeadlineAt ? { at: at(ctx.answerDeadlineAt), kind: 'question_timeout' } : null
    case 'delivered': return ctx.autoAcceptAt ? { at: at(ctx.autoAcceptAt), kind: 'auto_accept' } : null
    default: return null
  }
}

module.exports = { STATES, TERMINAL, CARRYING, ACTOR_KINDS, RULES, findRule, check, triggersFrom, holdsExpert, nextActionFor }
