import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api'
import { getToken } from '../lib/storage'
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
const refreshSyncedThisSession = new Set()

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

// The full stored record (code, capturedAt, source) while it is still inside the window; null otherwise.
function readStoredRecord() {
  if (!readStored()) return null
  try { return JSON.parse(storageGet()) } catch (_) { return null }
}

// Round 10: `source` records HOW the code got here — 'link' (a ?ref= URL), 'typed' (the checkout field) or 'account'
// (restored from the signed-in account on another device). It rides along to checkout so the admin can see which sales
// came from a shared link and which from a typed code. Older stored values have none.
const SOURCES = new Set(['link', 'typed', 'account'])
//
// Round 16 (feature gap): a link may also carry a partner's own channel tag — `?ref=CODE&sub=newsletter` — kept in the same
// record as `sub` and sent with the order, so the partner sees which channel earned the sale. Same rule as the server
// (lib/referralSub.js): 1-32 of a-z 0-9 _ -, anything else is ignored. A tag is only ever stored WITH its code.
const SUB_FORMAT_RE = /^[a-z0-9_-]{1,32}$/
function cleanSub(value) {
  const v = String(value || '').trim().toLowerCase()
  return SUB_FORMAT_RE.test(v) ? v : ''
}
function writeStored(code, source = 'link', capturedAt = Date.now(), sub = '') {
  const record = { code, capturedAt, source }
  const tag = cleanSub(sub)
  if (tag) record.sub = tag
  storageSet(JSON.stringify(record))
}

// Round 10 (feature gap): the code lived ONLY in this browser, so a visitor who clicked a partner's link on a phone and
// bought on a laptop — or cleared site data, or switched in-app browsers — was never credited. For a signed-in person the
// code is also kept on their ACCOUNT (users.referred_by_code, migration 0076). Best-effort and silent: a failed sync only
// means the code stays browser-local, exactly as before.
// `capturedAt` is when THIS browser first captured the code, so the account keeps the real start of the 30-day window
// instead of a fresh "now" (pushing an old local code used to stretch the window to ~60 days across two devices).
// Codes the server refuses (unusable / the buyer's own) are not pushed again this page session: restoreReferralFromAccount
// runs on every session refresh and would otherwise re-post the same refused code each time.
const syncRefused = new Set()
function syncToAccount(code, capturedAt, sub) {
  if (!getToken()) return
  if (code && syncRefused.has(code)) return
  const body = { code: code || null }
  if (code && Number.isFinite(capturedAt)) body.capturedAt = new Date(capturedAt).toISOString()
  // Round 17: the channel tag is kept on the account with the code, so a purchase on another device is still tagged.
  if (code && cleanSub(sub)) body.sub = cleanSub(sub)
  api.post('/partners/attribution', body)
    .then(res => { if (code && res?.data?.data?.stored === false) syncRefused.add(code) })
    .catch(() => {})
}

// A code removed while LOGGED OUT cannot be cleared on the account at that moment, so the account's copy would be
// restored at the next sign-in — resurrecting a code the buyer removed on purpose. Remember when it was removed; the
// next restore clears the account unless the account's code was captured AFTER the removal (a newer click elsewhere).
const CLEARED_KEY = 'passthrough_referral_cleared'
function markCleared()   { try { localStorage.setItem(CLEARED_KEY, String(Date.now())) } catch (_) {} }
function clearedAt()     { try { const n = Number(localStorage.getItem(CLEARED_KEY)); return Number.isFinite(n) && n > 0 ? n : 0 } catch (_) { return 0 } }
function dropClearedMark() { try { localStorage.removeItem(CLEARED_KEY) } catch (_) {} }

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
  // Round 18: the channel tag travels with the click so the partner sees visits per channel. A repeat visit with no tag
  // sends none (the stored tag is only trusted when it belongs to this code).
  const rec = readStoredRecord()
  api.post('/partners/track-click', { code, ...(rec?.code === code && rec.sub ? { sub: rec.sub } : {}) })
    .then(res => { if (res?.data?.valid === false) rejectCode(code); else { const rec = readStoredRecord(); syncToAccount(code, rec?.code === code ? rec.capturedAt : undefined, rec?.code === code ? rec.sub : undefined) } })
    .catch(() => {})
}
// The last location.search the synchronous capture looked at. It runs ONCE per distinct
// query string so a visitor who deliberately clears the code (setStoredReferralCode(''))
// while ?ref= is still in the URL doesn't get it silently re-applied by the next read.
let lastSyncedSearch = null

// Section 4 round 7 (bug): `?ref=` is a generic parameter name, so other tools put arbitrary values in it. Anything
// that cannot be a referral code (the server's own format: 2-50 letters, digits, `_` or `-`) is now ignored here
// rather than stored — it used to replace a real partner's attribution, and the server's answer could not undo
// that for an over-long value. Same pattern as CODE_FORMAT_RE in partners.controller.js.
const CODE_FORMAT_RE = /^[A-Z0-9_-]{2,50}$/
function subFromSearch(search) {
  try { return cleanSub(new URLSearchParams(search).get('sub')) } catch (_) { return '' }
}
function codeFromSearch(search) {
  try {
    const code = (new URLSearchParams(search).get('ref') || '').trim().toUpperCase()
    return CODE_FORMAT_RE.test(code) ? code : ''
  } catch (_) { return '' }
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
    writeStored(code, 'link', Date.now(), subFromSearch(search))
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
    writeStored(code, 'link', Date.now(), subFromSearch(location.search))   // also refreshes the attribution window on every ?ref= visit, even a repeat one
    lastSyncedSearch = location.search

    if ((previous !== code || pendingClicks.has(code)) && !trackedThisSession.has(code)) {
      trackedThisSession.add(code)
      trackClick(code)
    } else if (previous === code && !refreshSyncedThisSession.has(code)) {
      // Section 4 round 13 (bug): a repeat ?ref= visit slid the BROWSER's 30-day window forward (writeStored above) but never
      // told the account, so on another device (or after clearing site data) the account's older referred_at expired first.
      // Once per page session, push the refreshed start to the account (a no-op when signed out).
      refreshSyncedThisSession.add(code)
      syncToAccount(code, readStoredRecord()?.capturedAt, readStoredRecord()?.sub)
    }
    pendingClicks.delete(code)
  }, [location.search])
}

// Section 4 round 13: when this browser captured the stored code (ISO string), so registration can pass the REAL start of
// the attribution window to the server instead of the server stamping "now". '' when there is none.
export function getStoredReferralCapturedAt() {
  const rec = readStoredRecord()
  return rec && Number.isFinite(rec.capturedAt) ? new Date(rec.capturedAt).toISOString() : ''
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
  let keepSub = ''
  if (trimmed) {
    // Typing the SAME code that a tagged link stored keeps its channel tag; a different code never inherits one.
    keepSub = readStoredRecord()?.code === trimmed ? readStoredRecord().sub : ''
    writeStored(trimmed, 'typed', Date.now(), keepSub); dropClearedMark()
  }
  else { storageRemove(); if (!getToken()) markCleared() }
  // Removing the code on purpose must also clear it on the account, or it would be restored on the next sign-in.
  syncToAccount(trimmed, undefined, keepSub)
}

// How the stored code got here ('link' | 'typed' | 'account'), or '' when there is none / it predates this field.
export function getStoredReferralSource() {
  captureFromLocationNow()
  const rec = readStoredRecord()
  return rec && SOURCES.has(rec.source) ? rec.source : ''
}

// The partner's channel tag stored with the code ('' when the link carried none, or there is no live code).
export function getStoredReferralSub() {
  captureFromLocationNow()
  const rec = readStoredRecord()
  return rec ? cleanSub(rec.sub) : ''
}

// Called when a session is established or refreshed (AuthContext). Reconciles the browser's code with the account's,
// last click winning, in both directions:
//   - no code here, the account has a live one      -> adopt it (source 'account', its original timestamp)
//   - both, and the account's is newer              -> adopt the account's
//   - both differ and the browser's is newer / only the browser has one -> push the browser's to the account
export function restoreReferralFromAccount(user) {
  try {
    const accountCode = user?.referredByCode ? String(user.referredByCode).toUpperCase() : ''
    const accountAt = user?.referredAt ? Date.parse(user.referredAt) : NaN
    const accountLive = !!accountCode && Number.isFinite(accountAt) && Date.now() - accountAt <= ATTRIBUTION_TTL_MS
    const local = readStoredRecord()
    const removedAt = clearedAt()
    if (removedAt) {
      dropClearedMark()
      // Removed while signed out, and neither this browser nor the account captured a code AFTER that removal:
      // the buyer meant it gone, so clear the account's copy instead of adopting it.
      const recaptured = !!local && local.capturedAt > removedAt
      if (!recaptured && accountCode && !(accountLive && accountAt > removedAt)) { syncToAccount(''); return }
    }
    if (accountLive && (!local || (local.code !== accountCode && accountAt > local.capturedAt))) {
      if (!rejectedThisSession.has(accountCode)) writeStored(accountCode, 'account', accountAt, user?.referredSub)
      return
    }
    if (local && local.code !== accountCode) syncToAccount(local.code, local.capturedAt, local.sub)
    // Same code, but this browser knows the channel tag and the account does not (a tagged click that predates the tag being
    // kept on the account, or one the account never received): hand it over, unless the account's click is the newer one.
    else if (local && local.sub && local.sub !== (user?.referredSub || '') && (!Number.isFinite(accountAt) || local.capturedAt >= accountAt))
      syncToAccount(local.code, local.capturedAt, local.sub)
  } catch (_) { /* attribution is best-effort */ }
}
