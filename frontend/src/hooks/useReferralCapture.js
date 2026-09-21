import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api'

const STORAGE_KEY = 'passthrough_referral_code'

// AUDIT FIX (feature gap): this used to store the bare code string with no
// expiry at all — getStoredReferralCode() would keep returning a code
// forever, until a DIFFERENT ?ref= link happened to overwrite it. A single
// click on a partner's link months (or years) ago would silently keep
// attributing every future purchase on that browser to that partner, with
// nothing client-side to age it out. Server-side validation (referral.
// service.js's isCodeUsable — active/expires_at/usage_limit/partner status)
// protects the PARTNER's own code limits, but nothing protected against a
// stale attribution window on the VISITOR's side. Standard affiliate
// practice is a bounded attribution window independent of the code's own
// admin-set limits; 30 days matches this app's other "reasonable default"
// windows (e.g. ANON_SCAN_TTL_HOURS) in spirit; a click always refreshes it,
// exactly like Passthrough's other captured state (see the click-vs-
// navigation dedup below, which is unaffected by this).
const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function readStored() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch (_) {
    // Pre-fix value (a bare code string, no captured-at timestamp) — no way
    // to know its true age, so treat it as expired rather than letting an
    // untimestamped attribution live on indefinitely. The next real ?ref=
    // visit or manual code entry re-captures it in the new, timestamped
    // format going forward.
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
  if (!parsed?.code || !Number.isFinite(parsed.capturedAt)) { localStorage.removeItem(STORAGE_KEY); return null }
  if (Date.now() - parsed.capturedAt > ATTRIBUTION_TTL_MS) { localStorage.removeItem(STORAGE_KEY); return null }
  return parsed.code
}

function writeStored(code) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, capturedAt: Date.now() }))
}

// Mounted once, globally (see App.jsx), so a ?ref=CODE landing on ANY page
// — not just the homepage — gets captured. Runs on every route change
// (useLocation), but only re-fires the click-tracking call when the code
// actually changes, so internal navigation with the same stale query string
// doesn't spam the click counter.
export function useReferralCapture() {
  const location = useLocation()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const ref = params.get('ref')
    if (!ref) return

    const code = ref.trim().toUpperCase()
    const previous = readStored()
    writeStored(code)   // also refreshes the attribution window on every ?ref= visit, even a repeat one

    if (previous !== code) {
      // Fire-and-forget — a failed click log should never block navigation
      // or surface an error to the visitor.
      api.post('/partners/track-click', { code }).catch(() => {})
    }
  }, [location.search])
}

export function getStoredReferralCode() {
  return readStored() || ''
}

// Used by the manual "have a code?" entry field at checkout (FixBanner) —
// same storage key as automatic URL capture above, so a code entered by
// hand behaves identically to one picked up from a ?ref= link for the rest
// of the session (survives navigation, applies at payment time, ages out on
// the same attribution window).
export function setStoredReferralCode(code) {
  const trimmed = (code || '').trim().toUpperCase()
  if (trimmed) writeStored(trimmed)
  else localStorage.removeItem(STORAGE_KEY)
}
