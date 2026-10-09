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

api.interceptors.request.use(config => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  // Identifies this browser so the anonymous free scan is allowed per device, not per shared IP.
  config.headers['X-Device-Id'] = getDeviceId()
  // Remembered so the response side knows whether a session was actually
  // presented — a 401 on a request that carried no token isn't an "expiry".
  config.__hadToken = !!token
  // Which token this request actually carried, so a late failure can be matched
  // against the session that is current when it lands (see endSession's caller).
  config.__token = token || null
  // Uploads legitimately take long on slow mobile links (5MB @ ~500kbps ≈ 80s);
  // don't let the default 30s cut them off unless the caller chose a timeout
  // (an explicit `timeout` other than 30s, or `__customTimeout: true` for exactly 30s).
  if (typeof FormData !== 'undefined' && config.data instanceof FormData && config.__customTimeout !== true && config.timeout === 30_000)
    config.timeout = 180_000
  if (String(config.method || 'get').toLowerCase() === 'post' && config.__customTimeout !== true
      && config.timeout === 30_000 && LONG_RUNNING_POST.test(String(config.url || '')))
    config.timeout = LONG_REQUEST_TIMEOUT_MS
  return config
})

let sessionEnding = false

function endSession(reason) {
  if (sessionEnding) return            // several in-flight requests can all fail at once
  sessionEnding = true
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
      retryAfterSeconds: retryAfter, alreadyRetried: !!config.__retried, cancelled: false,
    })
    if (decision.retry && !verdict) {
      config.__retried = true
      // The first attempt's Authorization header is still on `config`; drop it so
      // the request interceptor re-reads the CURRENT token (or sends none if the
      // person signed out during the delay) instead of replaying a stale one.
      if (config.headers) {
        if (typeof config.headers.delete === 'function') config.headers.delete('Authorization')
        else delete config.headers.Authorization
      }
      await sleep(decision.delayMs)
      return api.request(config)
    }

    return Promise.reject(err)
  }
)

export default api
