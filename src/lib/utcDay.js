// The free-scan day is a UTC day: increment_scan_count_if_under_limit (0008/0015) resets the counter
// when it was last touched before the `p_today_midnight` it is handed, and the dashboard tells the
// person their allowance returns at the next UTC midnight (profile.controller.js scanQuota).
//
// `new Date().setHours(0, 0, 0, 0)` is LOCAL midnight. Cloudflare Workers always run in UTC, so the two
// agree in production, but under `wrangler dev` or a test run in another timezone the quota check
// reset at the wrong hour and disagreed with the number shown on the dashboard. Every "start of
// today" for the quota goes through this one function instead.
function utcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

module.exports = { utcMidnight }
