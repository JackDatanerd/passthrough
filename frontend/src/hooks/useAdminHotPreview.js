import { useCallback, useEffect, useState } from 'react'

// "Show my simulation on the real homepage" — for the signed-in admin's OWN browser only.
//
// The admin Hot categories screen can run a what-if. This is how that result reaches the homepage so the real section, in the
// real page, can be looked at and clicked through. It deliberately lives in this browser's localStorage and nowhere else:
// there is no server state, so no visitor can ever receive it, and it cannot be cached or served to anyone else. The homepage
// only reads it when the signed-in user is an ADMIN, always draws a banner saying the numbers are simulated, and forgets it
// after PREVIEW_MAX_AGE_MS so an old test cannot linger. What is read back is re-validated here: it is only ever drawn through
// the homepage's own rendering, but a hand-edited value must not be able to break the page.
const KEY = 'pt:admin-hot-preview'
const EVENT = 'pt:admin-hot-preview-changed'
export const PREVIEW_MAX_AGE_MS = 6 * 60 * 60 * 1000

const isRow = (r) => r && typeof r.category === 'string' && r.category.length > 0 && r.category.length <= 60
  && Number.isFinite(r.interviews) && r.interviews >= 0 && (r.changePct === null || r.changePct === undefined || Number.isFinite(r.changePct))
const isRows = (v) => Array.isArray(v) && v.length <= 12 && v.every(isRow)

// -> { hotCategories: { 7: rows, 30: rows, minReports }, threshold, savedAt } | null
export function readPreview(now = Date.now()) {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    const h = p && p.hotCategories
    if (!h || !isRows(h[7]) || !isRows(h[30])) return null
    if (!Number.isFinite(p.savedAt) || now - p.savedAt > PREVIEW_MAX_AGE_MS || p.savedAt > now + 60 * 1000) return null
    return {
      hotCategories: {
        7: h[7].map(r => ({ category: r.category, interviews: r.interviews, changePct: r.changePct ?? null })),
        30: h[30].map(r => ({ category: r.category, interviews: r.interviews, changePct: r.changePct ?? null })),
        minReports: Number.isFinite(h.minReports) ? h.minReports : 10,
      },
      threshold: Number.isFinite(p.threshold) ? p.threshold : null,
      savedAt: p.savedAt,
    }
  } catch (_) { return null }
}

function announce() { try { window.dispatchEvent(new Event(EVENT)) } catch (_) { /* no window */ } }

export function writePreview(hotCategories, threshold) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ hotCategories, threshold, savedAt: Date.now() }))
    announce()
    return true
  } catch (_) { return false }   // blocked / full storage: the admin screen says so
}

export function clearPreview() {
  try { window.localStorage.removeItem(KEY) } catch (_) { /* nothing to clear */ }
  announce()
}

// The homepage's view of it. `enabled` must be "the signed-in user is an admin"; for everyone else this is always null.
// Stays in step with the admin screen when that is open in another tab (storage event) or the same tab (custom event).
export default function useAdminHotPreview(enabled) {
  const [preview, setPreview] = useState(() => (enabled ? readPreview() : null))
  useEffect(() => {
    if (!enabled) { setPreview(null); return undefined }
    const sync = () => setPreview(readPreview())
    sync()
    window.addEventListener('storage', sync)
    window.addEventListener(EVENT, sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(EVENT, sync) }
  }, [enabled])
  const clear = useCallback(() => clearPreview(), [])
  return { preview: enabled ? preview : null, clear }
}
