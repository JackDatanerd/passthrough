// GET /api/stats — everything the homepage shows as evidence, in ONE public, edge-cacheable call:
// how many resumes were scanned, the interview rate (withheld until there are enough answers),
// this week's / month's hot fields, and the approved stories.
//
// Each piece degrades on its own: a failing aggregate becomes null / [] (the page falls back to its
// static copy for just that block) rather than a 500 that blanks the homepage. A degraded answer is
// never cached, so a blip cannot be pinned at the edge for five minutes.

const { getSupabase } = require('../config/supabase')
const constants = require('../config/constants')
const cryptoLib = require('../lib/crypto')
const { interviewRatePct, changePct, toPublicStory, STORY_STATUS } = require('../lib/outcomes')

const STORY_COLUMNS = 'scan_id, role_category, outcome, interview_count, interview_after_days, story_status, story_display_name, story_quote, story_text, story_show_credential, ' +
  'scans(ats_score, fix_ats_score, verification_code, verification_status, verification_revoked_at)'

async function safe(label, fn) {
  try {
    const { data, error } = await fn()
    if (error) throw error
    return { ok: true, data }
  } catch (err) {
    console.error(`Public stats (${label}):`, err.message)
    return { ok: false, data: null }
  }
}

async function getHomeStats(c) {
  const supabase = getSupabase(c.env)
  const min = constants.HOT_CATEGORY_MIN_REPORTS
  const [days7, days30] = constants.HOT_CATEGORY_WINDOWS

  const [stats, hot7, hot30, stories] = await Promise.all([
    safe('totals', () => supabase.rpc('public_home_stats')),
    safe('hot 7d', () => supabase.rpc('public_hot_categories', { p_days: days7, p_min: min })),
    safe('hot 30d', () => supabase.rpc('public_hot_categories', { p_days: days30, p_min: min })),
    safe('stories', () => supabase.from('scan_outcomes').select(STORY_COLUMNS)
      .eq('story_status', STORY_STATUS.APPROVED).eq('outcome', 'INTERVIEW')
      .order('story_moderated_at', { ascending: false }).limit(constants.HOMEPAGE_STORIES * 3)),
  ])

  const row = stats.ok && Array.isArray(stats.data) ? stats.data[0] : null
  const responses = row ? Number(row.responses) || 0 : 0
  const ratePct = row ? interviewRatePct(responses, Number(row.interviews) || 0) : null

  const hotShape = (res) => res.ok && Array.isArray(res.data)
    ? res.data.map(r => ({ category: r.role_category, interviews: Number(r.interviews) || 0, changePct: changePct(r.interviews, r.prev_interviews) }))
    : []

  const storyList = []
  if (stories.ok && Array.isArray(stories.data)) {
    for (const r of stories.data) {
      const id = (await cryptoLib.sha256(`story:${r.scan_id}`)).slice(0, 12)
      const pub = toPublicStory(r, id)
      if (pub) storyList.push(pub)
      if (storyList.length >= constants.HOMEPAGE_STORIES) break
    }
  }

  const healthy = stats.ok && hot7.ok && hot30.ok && stories.ok
  // Short browser cache, longer edge cache; 5 minutes of staleness is invisible on a number like this.
  c.header('Cache-Control', healthy ? 'public, max-age=60, s-maxage=300' : 'no-store')

  return c.json({ success: true, data: {
    stats: {
      resumesScanned: row ? Number(row.resumes_scanned) || 0 : null,
      responses,
      interviewRatePct: ratePct,
      minResponses: constants.OUTCOME_MIN_RESPONSES,
      since: ratePct !== null && row ? row.first_answer_at || null : null,
    },
    hotCategories: { [days7]: hotShape(hot7), [days30]: hotShape(hot30), minReports: min },
    stories: storyList,
    generatedAt: new Date().toISOString(),
  } })
}

module.exports = { getHomeStats }
