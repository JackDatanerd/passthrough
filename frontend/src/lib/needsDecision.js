import { useEffect, useSyncExternalStore } from 'react'
import api from './api'

// How many scans are waiting for a decision (scored, no fix chosen yet): the number on the "Scans" tab.
// Every dashboard page shows the tab strip, so the count lives in one small shared store instead of each page
// asking for it: one request (limit 1, only the total is read) is shared by whoever mounts first and reused for
// a minute. The Scans page asks again, with `force`, whenever it reloads its own list, so the tab never lags
// behind what the list shows. It belongs to one signed-in person: another user (sign out, sign in) never sees
// the previous one's number.
const FRESH_MS = 60 * 1000
let owner = null
let count = null
let loadedAt = 0
let inflight = null
// Whose request `inflight` is, and whether someone asked for a fresher answer while it was out.
let inflightOwner = null
let rerun = false
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

function adopt(userId) {
  if (owner === userId) return
  owner = userId; count = null; loadedAt = 0
  emit()
}

// `coalesce` (with `force`): refresh, but a request already out for this person IS the refresh — no second one is queued.
// For a caller that only just mounted (the Scans page on first render, behind the tab strip's own first load), whose "ask
// again" is not prompted by anything that happened after that request began.
export function loadNeedsDecision(userId, { force = false, coalesce = false } = {}) {
  if (!userId) return Promise.resolve()
  adopt(userId)
  // Only this person's own request is shared. Another person's (sign out, sign in as someone else while it is
  // still out) answers for them, and its result is thrown away on arrival, so reusing it left the new person
  // with no number at all.
  if (inflight && inflightOwner === userId) {
    // A request already out may have been read before whatever made the caller ask again (a scan was just
    // deleted): a forced refresh queues one more for when it lands — one, however many ask.
    if (force && !coalesce) rerun = true
    return inflight
  }
  if (!force && count !== null && Date.now() - loadedAt < FRESH_MS) return Promise.resolve()
  const mine = userId
  rerun = false
  // An async function, so that even a request that throws before returning a promise ends up in the catch below.
  const run = (async () => {
    try {
      const res = await api.get('/scan/history', { params: { status: 'NEEDS_DECISION', limit: 1 } })
      if (owner !== mine) return
      const total = Number(res.data?.data?.total)
      count = Number.isFinite(total) ? total : null
      loadedAt = Date.now()
      emit()
    } catch (_) {
      // a tab badge is an extra: never an error, never blocks the page
    }
  })()
  inflight = run; inflightOwner = mine
  // Cleared once it settles (and only if it is still the current one), also when the request failed before it began.
  run.then(() => {
    if (inflight !== run) return
    inflight = null; inflightOwner = null
    if (rerun) { rerun = false; loadNeedsDecision(owner, { force: true }) }
  })
  return run
}

// The count for this person, or null while unknown (or when there is none to show).
export function useNeedsDecisionCount(userId) {
  const value = useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => (owner === userId ? count : null),
  )
  useEffect(() => { loadNeedsDecision(userId) }, [userId])
  return value
}

// For tests.
export function resetNeedsDecision() { owner = null; count = null; loadedAt = 0; inflight = null; inflightOwner = null; rerun = false; emit() }
