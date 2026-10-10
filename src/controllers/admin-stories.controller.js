// Admin review of customer stories. Nothing a customer writes reaches the public homepage until it is
// approved here, and an approved story can be taken down at any time. Every decision is audit-logged
// (ids and the transition only — never the story text).

const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const { logAdminAction } = require('../lib/adminAudit')
const { STORY_STATUS } = require('../lib/outcomes')

const LIST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED']

function pageParams(ctx, defaultSize = 25, maxSize = 100) {
  const page = Math.max(1, parseInt(ctx.req.query('page') || '1', 10) || 1)
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(ctx.req.query('pageSize') || String(defaultSize), 10) || defaultSize))
  return { page, pageSize, from: (page - 1) * pageSize, to: (page - 1) * pageSize + pageSize - 1 }
}

// GET /api/admin/stories?status=PENDING|APPROVED|REJECTED   (default PENDING)
async function adminListStories(ctx) {
  const supabase = getSupabase(ctx.env)
  const { page, pageSize, from, to } = pageParams(ctx)
  const status = LIST_STATUSES.includes(ctx.req.query('status')) ? ctx.req.query('status') : STORY_STATUS.PENDING
  const { data, error, count } = await supabase.from('scan_outcomes')
    .select('scan_id, role_category, outcome, interview_count, interview_after_days, story_status, story_display_name, story_quote, story_text, story_show_credential, story_moderated_at, answered_at, ' +
      'scans(ats_score, fix_ats_score, verification_code, verification_status, verification_revoked_at)', { count: 'exact' })
    .eq('story_status', status).order('answered_at', { ascending: true }).range(from, to)
  if (error) throw error
  return ctx.json({ success: true, data: {
    stories: (data || []).map(r => ({
      scanId: r.scan_id, status: r.story_status, roleCategory: r.role_category, outcome: r.outcome,
      interviewCount: r.interview_count, interviewAfterDays: r.interview_after_days,
      displayName: r.story_display_name, quote: r.story_quote, text: r.story_text, showCredential: r.story_show_credential === true,
      scoreBefore: r.scans?.ats_score ?? null, scoreAfter: r.scans?.fix_ats_score ?? null,
      credentialLive: !!r.scans?.verification_code && (r.scans?.verification_status || 'ACTIVE') === 'ACTIVE' && !r.scans?.verification_revoked_at,
      answeredAt: r.answered_at, moderatedAt: r.story_moderated_at,
    })),
    total: count ?? (data || []).length, page, pageSize,
  } })
}

// POST /api/admin/stories/:id/moderate   { action: 'approve' | 'reject' }   (:id is the scan id)
async function adminModerateStory(ctx) {
  let body
  try { body = await ctx.req.json() } catch (_) { body = null }
  const parsed = z.object({ action: z.enum(['approve', 'reject']) }).safeParse(body)
  if (!parsed.success) return ctx.json({ success: false, message: 'action must be "approve" or "reject".' }, 400)
  const { action } = parsed.data
  const scanId = ctx.req.param('id')
  const supabase = getSupabase(ctx.env)

  const { data: row, error } = await supabase.from('scan_outcomes')
    .select('scan_id, outcome, story_status, story_text, story_quote, story_display_name').eq('scan_id', scanId).maybeSingle()
  if (error) throw error
  if (!row || row.story_status === STORY_STATUS.NONE) return ctx.json({ success: false, message: 'No story on this scan.' }, 404)
  if (action === 'approve' && (row.outcome !== 'INTERVIEW' || !row.story_text || !row.story_quote || !row.story_display_name))
    return ctx.json({ success: false, message: 'This story is incomplete and cannot be approved.' }, 409)

  const to = action === 'approve' ? STORY_STATUS.APPROVED : STORY_STATUS.REJECTED
  if (row.story_status === to) return ctx.json({ success: true, data: { changed: false, status: to } })

  const actor = ctx.get && ctx.get('user')
  // Guarded on the state we just read: if the author edited the story in between (which sends it back
  // to PENDING with new words), this update matches nothing instead of approving text nobody read.
  const { data: updated, error: upErr } = await supabase.from('scan_outcomes')
    .update({ story_status: to, story_moderated_at: new Date().toISOString(), story_moderated_by: actor?.id || null })
    .eq('scan_id', scanId).eq('story_status', row.story_status).eq('story_text', row.story_text).select('scan_id')
  if (upErr) throw upErr
  if (!updated || !updated.length) return ctx.json({ success: false, message: 'This story changed while you were reviewing it. Reload and review it again.' }, 409)

  await logAdminAction(ctx, supabase, action === 'approve' ? 'story.approve' : 'story.reject', 'scan', scanId, { from: row.story_status, to })
  return ctx.json({ success: true, data: { changed: true, status: to } })
}

module.exports = { adminListStories, adminModerateStory }
