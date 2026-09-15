import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api'

const STORAGE_KEY = 'passthrough_referral_code'

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
    const previous = localStorage.getItem(STORAGE_KEY)
    localStorage.setItem(STORAGE_KEY, code)

    if (previous !== code) {
      // Fire-and-forget — a failed click log should never block navigation
      // or surface an error to the visitor.
      api.post('/partners/track-click', { code }).catch(() => {})
    }
  }, [location.search])
}

export function getStoredReferralCode() {
  return localStorage.getItem(STORAGE_KEY) || ''
}

// Used by the manual "have a code?" entry field at checkout (FixBanner) —
// same storage key as automatic URL capture above, so a code entered by
// hand behaves identically to one picked up from a ?ref= link for the rest
// of the session (survives navigation, applies at payment time).
export function setStoredReferralCode(code) {
  const trimmed = (code || '').trim().toUpperCase()
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed)
  else localStorage.removeItem(STORAGE_KEY)
}
