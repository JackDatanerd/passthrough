// Append-only record of what an admin did to other people's data. Until now
// nothing recorded that: a bulk delete, a status change or a CSV export of
// every lead's email left no trace anywhere.
//
// Best-effort by design — an audit-write failure is logged and swallowed so it
// can never turn a completed admin action into an error (the action already
// happened; failing the response would just invite a retry that repeats it).
//
// `detail` must NOT carry personal data (names, emails, notes): it exists to
// answer "who did what to which record, when", and the row it points at is
// where the personal data lives (and is deleted from). Store ids, counts,
// field NAMES and status transitions — never the values a person typed.

async function logAdminAction(c, supabase, action, targetType, targetId, detail = {}) {
  try {
    const actor = c.get && c.get('user')
    const { error } = await supabase.from('admin_audit_log').insert({
      actor_id:    actor?.id || null,
      action,
      target_type: targetType,
      target_id:   targetId == null ? null : String(targetId),
      detail
    })
    if (error) console.error(`admin_audit_log insert failed (${action}):`, error.message)
  } catch (err) {
    console.error(`admin_audit_log insert failed (${action}):`, err.message)
  }
}

module.exports = { logAdminAction }
