// Experts Phase 2A: the permission matrix (engineering spec 3.2) in ONE place, and the registry every realm route is declared in.
// Y = allowed, M = allowed only for the account's own records ("claimed": a job currently assigned to it; "review": a delivery it is
// reviewing), - = never. stepUp: a fresh password check is required. reason: the caller must give a recorded reason.
// The permission test is GENERATED from this table: every role against every registered route, expecting allow or deny.

const ROLES = Object.freeze(['expert', 'grader', 'expert_admin', 'expert_support'])
const m = (expert, grader, expert_admin, expert_support, extra = {}) => Object.freeze({ expert, grader, expert_admin, expert_support, stepUp: false, reason: false, ...extra })

const MATRIX = Object.freeze({
  // the engineering spec 3.2 rows
  'brief.view_anonymised': m('Y', '-', 'Y', 'Y'),
  'job.take':             m('Y', '-', '-', '-'),
  'job.assign':           m('-', '-', 'Y', '-', { reason: true }),        // "Take a job: Admin Y (assign)"
  'job.view_full':        m('M', 'M', 'Y', 'Y'),                           // admin and support see it masked
  'job.view_contact':     m('-', '-', 'Y', '-', { stepUp: true, reason: true }),
  'job.edit_document':    m('M', '-', '-', '-'),
  'job.deliver':          m('M', '-', '-', '-'),
  'review.decide':        m('-', 'Y', 'Y', '-'),
  'earnings.view':        m('M', 'M', 'Y', 'Y'),
  'standing.change':      m('-', '-', 'Y', '-', { reason: true }),
  'money.refund':         m('-', '-', 'Y', '-', { stepUp: true, reason: true }),   // refund, credit, run payout
  'settings.change':      m('-', '-', 'Y', '-', { stepUp: true, reason: true }),
  'expert.pause_resume_end': m('-', '-', 'Y', '-', { reason: true }),
  // what the realm itself needs beyond that table (console shell, own account)
  'board.view':           m('-', '-', 'Y', 'Y'),       // job board, timeline: support reads order status (product spec 8.1)
  'job.reassign':         m('-', '-', 'Y', '-', { reason: true }),
  'directory.view':       m('-', '-', 'Y', '-'),       // expert directory: names, status, load. No payout details exist in 2A
  'audit.view':           m('-', '-', 'Y', '-'),
  'account.self':         m('Y', 'Y', 'Y', 'Y'),       // me, sessions, change password, sign out
})

const RANK = { '-': 0, M: 1, Y: 2 }
// The strongest grant across all the roles the account holds. scope: 'any' (Y) or 'own' (M).
function can(roles, action) {
  const row = MATRIX[action]
  if (!row) return { allowed: false, scope: null, stepUp: false, reason: false }
  let best = '-'
  for (const r of roles || []) if (ROLES.includes(r) && RANK[row[r]] > RANK[best]) best = row[r]
  return { allowed: best !== '-', scope: best === 'Y' ? 'any' : best === 'M' ? 'own' : null, stepUp: row.stepUp, reason: row.reason }
}

// --- the route registry: every realm route is declared through define(), so nothing is mounted without a stated policy --------------
// policy: { action } (a matrix action) | { auth: 'public' | 'pending' | 'session' }
//   public  = no session needed (sign-in, password reset request)
//   pending = a password-checked session whose second factor is still to do (two-factor enrolment and challenge)
//   session = a fully signed-in session of ANY role (own account: me, sessions)
const REGISTRY = []
function define(router, realm, method, path, policy, ...handlers) {
  if (!policy || (!policy.action && !policy.auth)) throw new Error(`route ${method} ${path} has no permission policy`)
  if (policy.action && !MATRIX[policy.action]) throw new Error(`route ${method} ${path}: unknown action ${policy.action}`)
  if (!REGISTRY.some(r => r.realm === realm && r.method === method.toUpperCase() && r.path === path))      // a module loaded twice (tests) registers once
    REGISTRY.push(Object.freeze({ realm, method: method.toUpperCase(), path, policy: Object.freeze({ ...policy }) }))
  router[method.toLowerCase()](path, ...handlers)
}
const routesOf = realm => REGISTRY.filter(r => r.realm === realm)

module.exports = { ROLES, MATRIX, can, define, routesOf, REGISTRY }
