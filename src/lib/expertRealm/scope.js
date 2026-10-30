// Experts Phase 2A (AUDIT A2, G3): the ONE place that turns a permission grant's scope into "may this account touch this job".
// can() says what a role may do (scope 'any' = Y, 'own' = M); it cannot know whose job it is. Every route that carries a matrix action with
// an M cell must ask here, so the answer is the same everywhere and Phase 2B routes do not each hand-roll an ownership check.
//
//   'own'  : only a job currently assigned to the account
//   'any'  : a job that is not the account's own. Content (the brief, the document) is NEVER released on 'any' in 2A: operators and
//            support see state, timeline and money through the console routes, not what the customer wrote.
//
// jobAccess(grant, account, job, { content }) -> { allowed, via: 'own' | 'any' | null }
function jobAccess(grant, account, job, { content = false } = {}) {
  if (!grant || !grant.allowed || !account || !job) return { allowed: false, via: null }
  if (job.expert_id && job.expert_id === account.id) return { allowed: true, via: 'own' }
  if (grant.scope === 'any' && !content) return { allowed: true, via: 'any' }
  return { allowed: false, via: null }
}
module.exports = { jobAccess }
