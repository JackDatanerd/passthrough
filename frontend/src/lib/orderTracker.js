// Experts Phase 2A: what the customer's order tracker shows, as plain data (so it is testable without a DOM). Plain-language steps, the deadline
// as one absolute date and time WITH its time zone (never "in 2 days"), and the expert's first name, initial and tier once an expert has the order.
const STEPS = [
  { key: 'received', label: 'Order received', states: ['awaiting_payment', 'offered', 'open'] },
  { key: 'working', label: 'An expert is working on it', states: ['claimed', 'in_progress', 'waiting_customer'] },
  { key: 'checks', label: 'Final checks', states: ['in_review', 'final_checks'] },
  { key: 'ready', label: 'Ready for your review', states: ['delivered', 'revision'] },
  { key: 'done', label: 'Done', states: ['accepted'] },
]
const BANNERS = {
  refunded: 'This order was refunded.', cancelled: 'This order was cancelled.', disputed: 'This order is being looked at after a payment dispute. We will email you.',
}

export function formatDeadline(iso, { locale, timeZone } = {}) {
  if (!iso) return null
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', ...(timeZone ? { timeZone } : {}) }).format(d)      // timeStyle 'long' includes the zone name
}

export function trackerModel(order, opts = {}) {
  const state = order && order.state
  const idx = STEPS.findIndex(s => s.states.includes(state))
  const steps = STEPS.map((s, i) => ({ key: s.key, label: s.label, status: idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? 'current' : 'todo' }))
  const dueIso = state === 'revision' ? order.revisionDueAt : state === 'delivered' || state === 'accepted' ? null : order.promisedAt
  const deadline = ['awaiting_payment', 'refunded', 'cancelled', 'disputed'].includes(state) ? null : formatDeadline(dueIso, opts)
  const holds = ['claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'revision'].includes(state)
  const expert = holds && order.expert ? { name: order.expert, tier: order.expertTier || null } : null
  return {
    steps: BANNERS[state] ? [] : steps, banner: BANNERS[state] || null, deadline, expert,
    note: state === 'waiting_customer' ? 'The deadline is paused until you answer the expert\'s question, and moves back by the time it waits.'
      : null,
  }
}
