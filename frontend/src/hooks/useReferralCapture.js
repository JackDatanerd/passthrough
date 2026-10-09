import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api'
import { ATTRIBUTION_WINDOW_DAYS } from '../lib/partnerTerms'

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
// G6 (Payments & Pricing round 4): the window length lives in lib/partnerTerms.js so what partners
// are TOLD can never drift from what this enforces.
const ATTRIBUTION_TTL_MS = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000

// Codes already click-tracked in THIS page session. localStorage can be blocked (some in-app
// browsers / private modes), in which case readStored() always returns null and every route
// change that still carries ?ref= would look like a "new" code and fire another click.
const trackedThisSession = new Set()

// localStorage can throw (blocked storage in some in-app browsers / private
// modes). A ?ref= landing must never crash the app — attribution just won't
// persist there.
// SECTION 4 ROUND 5 (gap): with storage blocked the code was lost the moment the visitor left
// the ?ref= URL (every in-app browser that blocks storage), so a partner's click never became
// a credited sale. A copy is also kept in memory for the life of the page — attribution then
// survives in-app navigation even where nothing persists across loads. localStorage stays the
// source of truth whenever it works.
let memoryRaw = null
function storageGet() {
  try { return localStorage.getItem(STORAGE_KEY) ?? memoryRaw } catch (_) { return memoryRaw }
}
function storageSet(value) { memoryRaw = value; try { localStorage.setItem(STORAGE_KEY, value) } catch (_) {} }
function storageRemove()   { memoryRaw = null;  try { localStorage.removeItem(STORAGE_KEY) } catch (_) {} }

function readStored() {
  const raw = storageGet()
  if (!raw) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch (_) {
    // Pre-fix value (a bare code string, no captured-at timestamp) — no way
    // to know its true age, so treat it as expired rather than letting an
    // untimestamped attribution live on indefinitely. The next real ?ref=
    // visit or manual code entry re-captures it in the new, timestamped
    // format going forward.
    storageRemove()
    return null
  }
  if (!parsed?.code || !Number.isFinite(parsed.capturedAt)) { storageRemove(); return null }
  if (Date.now() - parsed.capturedAt > ATTRIBUTION_TTL_MS) { storageRemove(); return null }
  return parsed.code
}

function writeStored(code) {
  storageSet(JSON.stringify({ code, capturedAt: Date.now() }))
}

// Codes captured synchronously (see getStoredReferralCode) whose click has not been logged
// yet — the effect below still owes the server that click.
const pendingClicks = new Set()

// Section 4 round 6 (bug): `?ref=` is a generic query parameter (`?ref=producthunt`, `?ref=twitter`), and every
// value used to be stored as an attribution — wiping out a REAL partner's code the visitor arrived with earlier,
// refreshing its window with junk, and showing the buyer "that code doesn't look right" at checkout. The code is
// still stored the instant it is seen (so the first render and an immediate checkout can use it), but the click
// call now says whether the code is real; if the server says it is not, what was stored BEFORE is put back
// exactly as it was (same captured-at, so the real partner's window is not extended or shortened).
//   previousRawFor: code -> the raw storage value that was replaced when that code was captured.
//   rejectedThisSession: codes the server called invalid — never stored again this page session.
const previousRawFor = new Map()
const rejectedThisSession = new Set()

function currentStoredCode() {
  const raw = storageGet()
  if (!raw) return null
  try { return JSON.parse(raw)?.code || null } catch (_) { return null }
}

function rejectCode(code) {
  rejectedThisSession.add(code)
  const previousRaw = previousRawFor.get(code)
  previousRawFor.delete(code)
  if (currentStoredCode() !== code) return        // something else (a manual entry) already replaced it
  if (previousRaw) storageSet(previousRaw)
  else storageRemove()
}

function trackClick(code) {
  // Fire-and-forget — a failed click log should never block navigation or surface an error to the visitor.
  // `valid` is only ever acted on when it is exactly false: an older/failed response keeps the code, as before.
  api.post('/partners/track-click', { code })
    .then(res => { if (res?.data?.valid === false) rejectCode(code) })
    .catch(() => {})
}
// The last location.search the synchronous capture looked at. It runs ONCE per distinct
// query string so a visitor who deliberately clears the code (setStoredReferralCode(''))
// while ?ref= is still in the URL doesn't get it silently re-applied by the next read.
let lastSyncedSearch = null

function codeFromSearch(search) {
  try { return (new URLSearchParams(search).get('ref') || '').trim().toUpperCase() } catch (_) { return '' }
}

// SECTION 4 ROUND 4 (bug): pages seed their referral state from storage while rendering —
// `useState(getStoredReferralCode())` in Pricing and ScanResult — but the capture below
// runs in an effect, i.e. AFTER that first render. Landing straight on /pricing?ref=CODE
// therefore rendered the page with no code at all (full price, no discount banner) while
// storage received the code a moment later; a visitor arriving with a DIFFERENT code than
// the one already stored saw the stale one. Reading now captures a ?ref= that is in the
// URL right then, so the first render already has it. The effect still logs the click
// and refreshes the attribution window.
function captureFromLocationNow() {
  if (typeof window === 'undefined') return
  const search = window.location.search
  if (search === lastSyncedSearch) return
  lastSyncedSearch = search
  const code = codeFromSearch(search)
  if (!code || rejectedThisSession.has(code)) return
  if (readStored() !== code) {
    previousRawFor.set(code, storageGet())
    writeStored(code)
    pendingClicks.add(code)
  }
}

// Mounted once, globally (see App.jsx), so a ?ref=CODE landing on ANY page
// — not just the homepage — gets captured. Runs on every route change
// (useLocation), but only re-fires the click-tracking call when the code
// actually changes, so internal navigation with the same stale query string
// doesn't spam the click counter.
export function useReferralCapture() {
  const location = useLocation()

  useEffect(() => {
    // A blank/whitespace-only ref is treated exactly like no ref param at all, so it can
    // never clobber a real, already-stored attribution.
    const code = codeFromSearch(location.search)
    if (!code || rejectedThisSession.has(code)) return

    const previous = readStored()
    // Remember what this visit replaces (unless the synchronous capture already did) so a code the server calls
    // invalid can be undone. A repeat visit with the SAME code replaces nothing worth restoring.
    if (previous !== code && !previousRawFor.has(code)) previousRawFor.set(code, storageGet())
    writeStored(code)   // also refreshes the attribution window on every ?ref= visit, even a repeat one
    lastSyncedSearch = location.search

    if ((previous !== code || pendingClicks.has(code)) && !trackedThisSession.has(code)) {
      trackedThisSession.add(code)
      trackClick(code)
    }
    pendingClicks.delete(code)
  }, [location.search])
}

export function getStoredReferralCode() {
  captureFromLocationNow()
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
  else storageRemove()
}
