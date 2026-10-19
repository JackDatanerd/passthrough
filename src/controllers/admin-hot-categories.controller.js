// Admin view of the homepage "Hot categories" block.
//
// Nothing is published by hand: the public page ranks fields live from the interview reports customers give in the
// follow-up (GET /api/stats -> public_hot_categories()). A field is listed only once it has `minReports` reports in the
// window. This screen shows how far each field is from that line, and lets an admin ask "what if" — a different
// threshold, or extra reports on a field — and see the result. The simulation is read-only: it is computed per request,
// stored nowhere, and has no way to reach the public endpoint, so a test can never put invented numbers on the live page.

const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const constants = require('../config/constants')
const { tally, rank } = require('../lib/hotCategories')

const PAGE = 1000          // PostgREST's default page size
const MAX_ROWS = 20000     // enough for any realistic month of interview reports; beyond it the answer says so

// Interview reports from the last 2 x (longest window) days — the longest window plus the period before it, which is
// what the arrows compare against. Only the two columns the ranking needs.
async function loadReports(supabase, nowMs, windows) {
  const since = new Date(nowMs - 2 * Math.max(...windows) * 24 * 60 * 60 * 1000).toISOString()
  const rows = []
  let truncated = false
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('scan_outcomes')
      .select('role_category, answered_at')
      .eq('outcome', 'INTERVIEW').gte('answered_at', since)
      .order('answered_at', { ascending: false }).range(from, from + PAGE - 1)
    if (error) throw error
    const page = data || []
    rows.push(...page)
    if (page.length < PAGE) break
    if (rows.length >= MAX_ROWS) { truncated = true; break }
  }
  return { rows, truncated }
}

async function build(ctx, { minReports, adds }) {
  const supabase = getSupabase(ctx.env)
  const windows = constants.HOT_CATEGORY_WINDOWS
  const nowMs = Date.now()
  const { rows, truncated } = await loadReports(supabase, nowMs, windows)
  const tallies = tally(rows, windows, nowMs)

  const perWindow = {}
  const hotCategories = { minReports }
  for (const days of windows) {
    const r = rank(tallies[days], { minReports, adds: adds[days] || {} })
    hotCategories[days] = r.publicRows
    perWindow[days] = {
      fields: r.fields, qualifying: r.qualifying, uncategorised: r.uncategorised, interviews: r.interviews,
      // With no qualifying field the homepage falls back to its labelled sample table for this window.
      showsSample: r.publicRows.length === 0,
    }
  }
  return { threshold: minReports, defaultThreshold: constants.HOT_CATEGORY_MIN_REPORTS, windows, perWindow, hotCategories, truncated, generatedAt: new Date(nowMs).toISOString() }
}

// GET /api/admin/hot-categories — the real counts, against the real threshold.
async function adminHotCategories(ctx) {
  const data = await build(ctx, { minReports: constants.HOT_CATEGORY_MIN_REPORTS, adds: {} })
  return ctx.json({ success: true, data: { ...data, simulated: false } })
}

const addSchema = z.object({
  category: z.enum(constants.ROLE_CATEGORIES),
  days7:  z.number().int().min(0).max(10000).optional(),
  days30: z.number().int().min(0).max(10000).optional(),
})
const simulateSchema = z.object({
  minReports: z.number().int().min(1).max(1000).optional(),
  adds: z.array(addSchema).max(constants.ROLE_CATEGORIES.length).optional(),
})

// POST /api/admin/hot-categories/simulate   { minReports?, adds?: [{ category, days7?, days30? }] }
// Same answer as the GET, with the what-if applied. `adds` are EXTRA current-window reports on top of the real ones.
async function adminSimulateHotCategories(ctx) {
  let body
  try { body = await ctx.req.json() } catch (_) { body = {} }
  const parsed = simulateSchema.safeParse(body && typeof body === 'object' && !Array.isArray(body) ? body : {})
  if (!parsed.success) return ctx.json({ success: false, message: 'minReports must be 1–1000 and each simulated count 0–10000, for a known field.' }, 400)
  const { minReports = constants.HOT_CATEGORY_MIN_REPORTS, adds = [] } = parsed.data
  const [w7, w30] = constants.HOT_CATEGORY_WINDOWS
  const byWindow = { [w7]: {}, [w30]: {} }
  for (const a of adds) {
    if (a.days7)  byWindow[w7][a.category]  = (byWindow[w7][a.category]  || 0) + a.days7
    if (a.days30) byWindow[w30][a.category] = (byWindow[w30][a.category] || 0) + a.days30
  }
  const data = await build(ctx, { minReports, adds: byWindow })
  return ctx.json({ success: true, data: { ...data, simulated: true } })
}

module.exports = { adminHotCategories, adminSimulateHotCategories }
