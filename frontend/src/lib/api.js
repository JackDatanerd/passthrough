import axios from 'axios'
import { resolveApiBase } from './apiUrl'
import { normalizeBlobError, shouldRetryRequest } from './errors'
import {
  TOKEN_KEY, USER_KEY, SESSION_ENDED_EVENT,
  classifyAuthFailure, isProtectedPath, failureScope,
} from './session'
import { getToken, getDeviceId, storageRemove } from './storage'
import { setFlash, FLASH_ADMIN_DENIED } from './flash'

// Re-exported so pages can `import api, { getErrorMessage } from '../lib/api'`.
export { getErrorMessage } from './errors'
export { SESSION_ENDED_EVENT } from './session'

// Dev:  Vite proxy handles /api -> localhost:4000
// Prod: VITE_API_URL=https://api.passthrough.dev  (with or without the trailing
//       /api — resolveApiBase() normalises both; every Worker route lives under /api)
const api = axios.create({
  baseURL: resolveApiBase(import.meta.env.VITE_API_URL),
  // Without a timeout a stalled connection left the UI spinning forever.
  timeout: 30_000,
})

// POST endpoints that run an AI call (or a PDF render) INSIDE the request. The Worker gives a single
// Claude call up to 90s (claude.service LONG_CALL_TIMEOUT_MS) and /structure runs two of them back to
// back (parse, then score), so the generic 30s cut the client off while the server was still working
// and finished anyway — the person saw "timed out / check your connection", and a retry repeated the work.
export const LONG_REQUEST_TIMEOUT_MS = 150_000
const LONG_RUNNING_POST = /^\/scan\/[^/?#]+\/(structure|cover-letter|regenerate-pdf)(?:[?#]|$)/
// SCAN/ATS ROUND 4: the same applies to two PATCHes the POST-only rule above missed. Saving an edit to a DELIVERED resume
// re-scores it (a Claude call), re-generates the designed-PDF HTML (a second Claude call, up to 90s) and renders the PDF in
// a browser, all inside the one request — the heaviest call in the product, and the one most likely to be cut off at 30s
// while the server finished anyway. Editing the free scan's data re-scores it (one Claude call).
const LONG_RUNNING_PATCH = /^\/scan\/[^/?#]+\/(delivered-resume|resume-data)(?:[?#]|$)/
// SHARED FRONTEND (section 11): the draft PDF download is a GET that renders in a browser on the server. It got the
// generic 30s cut-off AND the automatic GET retry on a timeout, which started a second render on top of the first.
// It now gets the long timeout and is never auto-retried (the person can press Download again).
const LONG_RUNNING_GET = /^\/(?:scan\/[^/?#]+\/download-draft-pdf|profile\/download-pdf)(?:[?#]|$)/  // + the saved-profile PDF (profile round 9): same in-request render

// Routes that sit behind the Worker's step-up gate (middleware/adminOnly.js `stepUp`): the admin console, the
// admin side of partners (payout runs, links, ledger adjustments) and payment refunds / resolutions.
const STEP_UP_URL = /^\/(?:admin|partners|payments)(?:[/?#]|$)/
export function isStepUpUrl(url) { return STEP_UP_URL.test(String(url || '')) }

api.interceptors.request.use(config => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  // Identifies this browser so the anonymous free scan is allowed per device, not per shared IP.
  config.headers['X-Device-Id'] = getDeviceId()
  // Remembered so the response side knows whether a session was actually
  // presented — a 401 on a request that carried no token isn't an "expiry".
  config.__hadToken = !!token
  // The elevation rides only on requests to the routes that can ask for it (see STEP_UP_URL), of ANY method:
  // GET /partners/:id/links is gated by the same step-up as the money actions, and the old "state-changing
  // calls only" rule meant it could never succeed (the prompt was shown, the password accepted, and the replay
  // went out without the token). Everything else — the public API, the user's own routes — never carries it.
  // The replay of a request the server just refused for step-up carries it wherever the route lives, so a gated
  // route outside the known prefixes still works (one extra round trip) instead of failing for good.
  if (stepUpToken && Date.now() < stepUpUntil && config.headers && (isStepUpUrl(config.url) || config.__stepUpTried))
    config.headers['X-Admin-Elevation'] = stepUpToken
  // Which token this request actually carried, so a late failure can be matched
  // against the session that is current when it lands (see endSession's caller).
  config.__token = token || null
  // Uploads legitimately take long on slow mobile links (5MB @ ~500kbps ≈ 80s);
  // don't let the default 30s cut them off unless the caller chose a timeout
  // (an explicit `timeout` other than 30s, or `__customTimeout: true` for exactly 30s).
  if (typeof FormData !== 'undefined' && config.data instanceof FormData && config.__customTimeout !== true && config.timeout === 30_000)
    config.timeout = 180_000
  const method = String(config.method || 'get').toLowerCase()
  if (config.__customTimeout !== true && config.timeout === 30_000
      && ((method === 'post' && LONG_RUNNING_POST.test(String(config.url || '')))
          || (method === 'patch' && LONG_RUNNING_PATCH.test(String(config.url || '')))
          || (method === 'get' && LONG_RUNNING_GET.test(String(config.url || '')))))
    config.timeout = LONG_REQUEST_TIMEOUT_MS
  if (method === 'get' && LONG_RUNNING_GET.test(String(config.url || ''))) config.__noRetry = true
  return config
})

// ── Admin step-up (Worker: ADMIN_STEP_UP_MINUTES, middleware/adminOnly.js) ─────────────────────────
// A refund / payout / ban answers 403 ADMIN_STEP_UP_REQUIRED until the admin re-enters their password.
// The password is asked for by whatever registered a prompt (AdminLayout's modal); the elevation token it
// buys lives in MEMORY only (a reload asks again) and rides on every request as X-Admin-Elevation.
let stepUpToken = null, stepUpUntil = 0, stepUpPrompt = null, stepUpPending = null
export function setStepUpPrompt(fn) { stepUpPrompt = fn }
export function clearStepUp() { stepUpToken = null; stepUpUntil = 0 }
async function ensureStepUp() {
  if (stepUpToken && Date.now() < stepUpUntil) return true
  if (!stepUpPrompt) return false
  if (!stepUpPending) {
    stepUpPending = (async () => {
      // After a wrong password the prompt is opened again WITH that fact, so it can say so — it used to reopen blank,
      // which looked like a glitch rather than a mistyped password.
      let incorrect = false
      for (;;) {
        const password = await stepUpPrompt({ incorrect })          // null/'' = cancelled
        if (!password) return false
        try {
          const res = await api.post('/admin/elevate', { password }, { __noStepUp: true })
          const d = res.data?.data
          stepUpToken = d.elevationToken
          stepUpUntil = Date.now() + Math.max(0, (d.expiresInSeconds - 5)) * 1000
          return true
        } catch (e) {
          if (e.response?.data?.code !== 'PASSWORD_INCORRECT') return false   // anything else: stop asking
          incorrect = true
        }
      }
    })().finally(() => { stepUpPending = null })
  }
  return stepUpPending
}

// A replayed request still carries the headers the FIRST attempt was built with. The request interceptor re-sets the
// bearer token and the elevation when there is a current one, but never removes them when there is not (signed out
// during the delay, elevation expired) — so a replay could present a stale session token or elevation. Dropped here;
// the interceptor puts back whatever is valid now.
function dropStaleAuthHeaders(config) {
  if (!config.headers) return
  for (const name of ['Authorization', 'X-Admin-Elevation']) {
    if (typeof config.headers.delete === 'function') config.headers.delete(name)
    else delete config.headers[name]
  }
}

let sessionEnding = false

function endSession(reason) {
  if (sessionEnding) return            // several in-flight requests can all fail at once
  sessionEnding = true
  clearStepUp()                         // an elevation belongs to the session that just ended
  storageRemove(TOKEN_KEY)
  storageRemove(USER_KEY)
  // Let AuthProvider drop `user` in-place (Navbar flips to "Sign in") without a page reload.
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { reason } }))

  const { pathname, search } = window.location
  // Only pages that REQUIRE a session get bounced (and they remember where the
  // user was, so login can send them back). Public pages just carry on
  // logged-out. A banned account is sent to the login notice from anywhere.
  //
  // BUG FIX (Section 11 audit): "from anywhere" used to exclude the one place
  // it matters most — /login itself. AuthProvider's refreshUser() calls
  // /auth/me on every app load regardless of page, and nothing here redirects
  // an already-authenticated visitor away from /login, so a session that gets
  // banned while its tab happens to already be sitting on /login hit the
  // `pathname !== '/login'` guard and fell into the silent-logout branch below
  // with no `?banned=true` ever set — the person was just logged out with zero
  // explanation. Expired sessions still only redirect off pages that actually
  // require one; a banned account no longer has an exception for /login.
  if (reason === 'banned' || (pathname !== '/login' && isProtectedPath(pathname))) {
    const flag = reason === 'banned' ? 'banned=true' : 'expired=true'
    const next = reason === 'banned' ? '' : `&next=${encodeURIComponent(pathname + search)}`
    window.location.replace(`/login?${flag}${next}`)
    // If the navigation is cancelled (an unsaved-changes prompt answered "Stay"), the page lives on with no token;
    // without this the flag stayed set for good and a later session end was ignored.
    setTimeout(() => { sessionEnding = false }, 3000)
  } else {
    setTimeout(() => { sessionEnding = false }, 1000)
  }
}

let probing = false
function probeCurrentSession() {
  if (probing) return
  probing = true
  api.get('/auth/me').then(() => {}, () => {}).finally(() => { probing = false })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

api.interceptors.response.use(
  res => res,
  async err => {
    await normalizeBlobError(err)

    const status = err.response?.status
    const code = err.response?.data?.code
    // Cancelled on purpose (AbortController) or not an axios request error at all: nothing to
    // classify, retry or redirect on.
    if (axios.isCancel(err) || !err.config) return Promise.reject(err)
    const config = err.config

    // Step-up: ask once for the password, then replay the request that was refused.
    if (status === 403 && code === 'ADMIN_STEP_UP_REQUIRED' && !config.__noStepUp && !config.__stepUpTried) {
      config.__stepUpTried = true
      clearStepUp()
      if (await ensureStepUp()) { dropStaleAuthHeaders(config); return api.request(config) }
      return Promise.reject(err)
    }

    let verdict = classifyAuthFailure({ status, code, hadToken: !!config.__hadToken, url: config.url })
    // A failure from a request sent under a session that is no longer the current
    // one (signed out / signed in as someone else meanwhile) says nothing about
    // the current session — ending it would log the new account out.
    if (verdict) {
      const scope = failureScope(config.__token, getToken())
      if (scope === 'stale') return Promise.reject(err)
      if (scope === 'probe') {
        // An older token of this same session failed while a newer one is held (see failureScope). Don't
        // sign the person out on that alone — ask the server about the token held NOW; if the session
        // really is dead, THAT request fails as 'current' and ends it through this same interceptor.
        probeCurrentSession()
        return Promise.reject(err)
      }
      endSession(verdict)
    }

    // A 403 from the admin gate saying the ACCOUNT is not an admin (middleware/adminOnly.js,
    // code ADMIN_REQUIRED): a non-admin who reached an /admin/* page is sent somewhere useful and
    // told why (a one-shot notice the dashboard shows). Deliberately narrow: the other admin 403
    // (ADMIN_NETWORK_DENIED — a real admin on a network outside the allow-list) stays on the page so
    // its own message is displayed instead of silently bouncing the admin away, and a 403 that is
    // about anything else never moves the person. The message match covers a server not yet
    // sending codes.
    if (status === 403 && !verdict && window.location.pathname.startsWith('/admin')
        && (code === 'ADMIN_REQUIRED' || (!code && err.response?.data?.message === 'Admin access required'))) {
      setFlash(FLASH_ADMIN_DENIED)
      window.location.replace('/dashboard')
    }

    // One automatic retry for idempotent GETs that failed transiently.
    const retryAfter = Number(err.response?.headers?.['retry-after'])
    const decision = shouldRetryRequest({
      method: config.method, status, hasResponse: !!err.response,
      retryAfterSeconds: retryAfter, alreadyRetried: !!config.__retried || !!config.__noRetry, cancelled: false,
    })
    if (decision.retry && !verdict) {
      config.__retried = true
      // The first attempt's Authorization / elevation headers are still on `config`; drop them so the request
      // interceptor re-reads the CURRENT token and elevation (or sends none if the person signed out, or the elevation
      // lapsed, during the delay) instead of replaying stale ones.
      dropStaleAuthHeaders(config)
      await sleep(decision.delayMs)
      return api.request(config)
    }

    return Promise.reject(err)
  }
)

export default api
