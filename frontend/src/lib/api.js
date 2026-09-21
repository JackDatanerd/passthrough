import axios from 'axios'
import { resolveApiBase } from './apiUrl'
import { normalizeBlobError, shouldRetryRequest } from './errors'
import {
  TOKEN_KEY, USER_KEY, SESSION_ENDED_EVENT,
  classifyAuthFailure, isProtectedPath,
} from './session'

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

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  // Remembered so the response side knows whether a session was actually
  // presented — a 401 on a request that carried no token isn't an "expiry".
  config.__hadToken = !!token
  // Uploads legitimately take long on slow mobile links (5MB @ ~500kbps ≈ 80s);
  // don't let the default 30s cut them off unless the caller chose a timeout.
  if (typeof FormData !== 'undefined' && config.data instanceof FormData && config.__customTimeout !== true && config.timeout === 30_000)
    config.timeout = 180_000
  return config
})

let sessionEnding = false

function endSession(reason) {
  if (sessionEnding) return            // several in-flight requests can all fail at once
  sessionEnding = true
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  // Let AuthProvider drop `user` in-place (Navbar flips to "Sign in") without a page reload.
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { reason } }))

  const { pathname, search } = window.location
  // Only pages that REQUIRE a session get bounced (and they remember where the
  // user was, so login can send them back). Public pages just carry on
  // logged-out. A banned account is sent to the login notice from anywhere.
  if (pathname !== '/login' && (reason === 'banned' || isProtectedPath(pathname))) {
    const flag = reason === 'banned' ? 'banned=true' : 'expired=true'
    const next = reason === 'banned' ? '' : `&next=${encodeURIComponent(pathname + search)}`
    window.location.replace(`/login?${flag}${next}`)
  } else {
    setTimeout(() => { sessionEnding = false }, 1000)
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

api.interceptors.response.use(
  res => res,
  async err => {
    await normalizeBlobError(err)

    const status = err.response?.status
    const code = err.response?.data?.code
    const config = err.config || {}

    const verdict = classifyAuthFailure({ status, code, hadToken: !!config.__hadToken, url: config.url })
    if (verdict) endSession(verdict)

    // A 403 from an admin-gated endpoint (server-side role check failed — see
    // middleware/adminOnly.js): a non-admin who reached an /admin/* page is sent
    // somewhere useful instead of being parked on a page with nothing to load.
    // Scoped to /admin paths only — a 403 elsewhere means something different.
    if (status === 403 && !verdict && window.location.pathname.startsWith('/admin')) {
      window.location.replace('/dashboard')
    }

    // One automatic retry for idempotent GETs that failed transiently.
    const retryAfter = Number(err.response?.headers?.['retry-after'])
    const decision = shouldRetryRequest({
      method: config.method, status, hasResponse: !!err.response,
      retryAfterSeconds: retryAfter, alreadyRetried: !!config.__retried,
    })
    if (decision.retry && !verdict) {
      config.__retried = true
      await sleep(decision.delayMs)
      return api.request(config)
    }

    return Promise.reject(err)
  }
)

export default api
