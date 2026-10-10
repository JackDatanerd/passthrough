import { useEffect, useState } from 'react'
import api from '../lib/api'
import { STATS_FALLBACK, MIN_LIVE_SCANS, SAMPLE_STORIES, SAMPLE_HOT } from '../lib/homeContent'

// The homepage's evidence block: GET /api/stats, merged with the static fallbacks in homeContent.js.
//
// Rules, in order of importance:
//   * live data always wins over fallback, block by block;
//   * anything that is NOT live carries a flag (`isFallback` / `isSample`) so the page can label it —
//     placeholder content must never pass as real;
//   * a failed or slow request changes nothing: the page renders from the fallbacks immediately and
//     never waits on, or breaks because of, the network.
const TTL_MS = 5 * 60 * 1000
let cache = null            // { at, data }
let inflight = null

function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data)
  if (!inflight) {
    inflight = api.get('/stats').then(res => {
      cache = { at: Date.now(), data: res.data.data }
      return cache.data
    }).catch(() => null).finally(() => { inflight = null })
  }
  return inflight
}

// Exposed for tests only.
export function _resetHomeDataCache() { cache = null; inflight = null }

export function mergeHomeData(live) {
  const s = live?.stats
  const liveScans = Number.isFinite(s?.resumesScanned) && s.resumesScanned >= MIN_LIVE_SCANS ? s.resumesScanned : null
  const liveRate = Number.isFinite(s?.interviewRatePct) ? s.interviewRatePct : null

  const hotFor = (days) => {
    const rows = live?.hotCategories?.[days]
    if (Array.isArray(rows) && rows.length) return { rows: rows.map(r => ({ category: r.category, interviews: r.interviews, changePct: r.changePct ?? null })), isSample: false }
    return { rows: SAMPLE_HOT[days].map(([category, interviews, changePct]) => ({ category, interviews, changePct })), isSample: true }
  }

  const liveStories = Array.isArray(live?.stories) ? live.stories : []
  return {
    scans: liveScans !== null ? { value: liveScans, isFallback: false } : { value: STATS_FALLBACK.resumesScanned, isFallback: true },
    rate: liveRate !== null
      ? { pct: liveRate, responses: s.responses ?? null, since: s.since ?? null, isFallback: false }
      : { pct: STATS_FALLBACK.interviewRatePct, responses: null, since: null, isFallback: true },
    minReports: live?.hotCategories?.minReports ?? 10,
    hot: { 7: hotFor(7), 30: hotFor(30) },
    stories: liveStories.length ? { list: liveStories, isSample: false } : { list: SAMPLE_STORIES, isSample: true },
  }
}

export default function useHomeData() {
  const [live, setLive] = useState(() => cache?.data ?? null)
  useEffect(() => {
    let cancelled = false
    load().then(d => { if (!cancelled && d) setLive(d) })
    return () => { cancelled = true }
  }, [])
  return mergeHomeData(live)
}
