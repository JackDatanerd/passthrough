// Experts Phase 2A: the expert realm's audit log writer (table expert_audit_log, migration 0124). Every sensitive read or action by an
// expert-realm actor goes through audit(). The detail holds identifiers, counts and reason codes ONLY: never resume text, contact
// details, names, tokens or secrets. Unsafe keys are dropped and long strings cut, so a careless caller cannot leak by accident.

const DENY_KEY = /(email|phone|name|body|text|resume|content|password|token|secret|code|address|cookie|authorization|linkedin|url)/i
const MAX_STR = 120

function safeDetail(detail) {
  const out = {}
  if (!detail || typeof detail !== 'object') return out
  for (const [k, v] of Object.entries(detail)) {
    if (DENY_KEY.test(k) && !/^(reason_code|error_code|result_code|outcome_code)$/.test(k)) continue
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v
    else if (typeof v === 'string') out[k] = v.length > MAX_STR ? v.slice(0, MAX_STR) : v
    else if (Array.isArray(v) && v.length <= 20 && v.every(x => typeof x === 'number' || (typeof x === 'string' && x.length <= 60))) out[k] = v
  }
  return out
}

// grader and expert act as 'expert'; expert_admin and expert_support act as 'operator' (the table's actor_kind check allows three kinds).
const actorKindOf = roles => ((roles || []).some(r => r === 'expert_admin' || r === 'expert_support') ? 'operator' : 'expert')

// required: true = fail closed (the caller refuses the request when the log write fails). Used for reads of job content and for money.
async function audit(supabase, { actorKind, actorId, roles, action, targetType, targetId, detail, required = false }) {
  const row = { actor_kind: actorKind || actorKindOf(roles), actor_id: actorId || null, action, target_type: targetType || 'none',
    target_id: targetId == null ? null : String(targetId).slice(0, 80), detail: { ...safeDetail(detail), ...(roles && roles.length ? { roles } : {}) } }
  try {
    const { error } = await supabase.from('expert_audit_log').insert(row)
    if (error) throw error
    return { ok: true }
  } catch (_) {
    if (required) { const e = new Error('audit write failed'); e.code = 'AUDIT_FAILED'; throw e }
    return { ok: false }
  }
}

module.exports = { audit, safeDetail, actorKindOf }
