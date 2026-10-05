// How the free-scan allowance is worded. `quota` is what GET /api/profile returns:
// { limit, used, remaining, resetsAt } — resetsAt is the next UTC midnight as an ISO string,
// shown here in the viewer's own clock so "resets at 3:00 AM" means THEIR 3 AM.
// Pure, so the rules can be tested. Returns null when there is nothing trustworthy to say.
export function describeQuota(quota) {
  if (!quota || !Number.isFinite(quota.limit) || !Number.isFinite(quota.remaining)) return null
  const when = new Date(quota.resetsAt)
  const time = Number.isNaN(when.getTime()) ? null : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const limit = quota.limit
  const remaining = Math.max(0, Math.min(limit, quota.remaining))
  if (remaining === 0) {
    return { exhausted: true, text: `You've used all ${limit} free scans for today.${time ? ` They come back at ${time}.` : ''}` }
  }
  return {
    exhausted: false,
    text: `${remaining} of ${limit} free scan${limit === 1 ? '' : 's'} left today${time ? ` · resets at ${time}` : ''}`,
  }
}
