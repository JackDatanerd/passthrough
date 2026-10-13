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
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

function adopt(userId) {
  if (owner === userId) return
  owner = userId; count = null; loadedAt = 0
  emit()
}

export function loadNeedsDecision(userId, { force = false } = {}) {
  if (!userId) return Promise.resolve()
  adopt(userId)
  if (inflight) return inflight
  if (!force && count !== null && Date.now() - loadedAt < FRESH_MS) return Promise.resolve()
  const mine = userId
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
  inflight = run
  // Cleared once it settles (and only if it is still the current one), also when the request failed before it began.
  run.then(() => { if (inflight === run) inflight = null })
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
export function resetNeedsDecision() { owner = null; count = null; loadedAt = 0; inflight = null; emit() }
