// Turns whatever axios (or the code around it) threw into text a person can act on.
//
// Before this existed, ~20 call sites each did `err.response?.data?.message ||
// 'Some fallback'`. That has three problems this fixes in one place:
//   1. The backend's Zod handler answers 400 with { message: 'Validation
//      failed', errors: [{ field, message }] } — the specific reason lives in
//      `errors`, so users only ever saw the useless "Validation failed".
//   2. A dead network / timeout has no `response` at all, so the user saw e.g.
//      "Login failed." — indistinguishable from a wrong password.
//   3. Requests made with responseType:'blob' deliver error bodies as a Blob,
//      not parsed JSON (see normalizeBlobError).

const GENERIC = 'Something went wrong. Please try again.'

// "newPassword" -> "New password", "email" -> "Email", "experience.1.title" -> "Title".
// A path that ENDS in an array index ("extraRoleCategories.1", "ids.0") used to be labelled by the index
// alone — "1: Invalid enum value…", "0: Invalid lead id." — so it is named after the list it belongs to
// and says which item (1-based): "Extra role categories (item 2)". A path that is only an index has no
// name to give, and the message is shown on its own.
export function humanizeField(field) {
  if (!field) return ''
  const parts = String(field).split('.').filter(p => p !== '')
  const spell = word => {
    const spaced = String(word).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
  }
  let index = null
  while (parts.length && /^\d+$/.test(parts[parts.length - 1])) index = Number(parts.pop())
  const last = parts.pop()
  if (!last) return ''
  const label = spell(last)
  if (index !== null) return `${label} (item ${index + 1})`
  // "experience.2.bullets.1.text" used to read just "Text". An index earlier in the path says which item the field belongs to:
  // "Text (bullets item 2)", named after the nearest list.
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^\d+$/.test(parts[i]) && !/^\d+$/.test(parts[i - 1])) return `${label} (${spell(parts[i - 1]).toLowerCase()} item ${Number(parts[i]) + 1})`
  }
  return label
}

// True for a request that was aborted on purpose (AbortController / axios cancel).
export function isCancelError(err) {
  return !!err && (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError')
}

// How long the server asked the client to wait (the Retry-After header on a 429 / 503), in whole seconds, or null when the
// response carries none. The header is either a number of seconds or an HTTP date; both are understood. The Worker sends it on
// every 429 and exposes it through CORS (middleware/cors.js) precisely so the person can be told how long.
export function getRetryAfterSeconds(err, now = Date.now()) {
  const h = err?.response?.headers
  if (!h) return null
  let raw = null
  try { raw = typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] ?? h['Retry-After']) } catch (_) { raw = null }
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const text = String(raw).trim()
  const secs = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - now) / 1000)
  return Number.isFinite(secs) && secs > 0 ? secs : null
}

// "about 15 minutes", "about 1 hour", "a few seconds" — rounded UP, so the person is never told to retry too early.
export function formatWait(seconds) {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s <= 60) return s <= 10 ? 'a few seconds' : `about ${Math.ceil(s / 5) * 5} seconds`
  const mins = Math.ceil(s / 60)
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`
  const hours = Math.ceil(mins / 60)
  return `about ${hours} hour${hours === 1 ? '' : 's'}`
}

// The sentence added to a 429 so the person knows when to come back. Skipped when the server's own message already names a time.
function waitSentence(err, message) {
  if (err?.response?.status !== 429) return ''
  const secs = getRetryAfterSeconds(err)
  if (!secs || /\b\d+\s*(?:second|minute|hour|min|sec|hr)s?\b/i.test(message || '')) return ''
  return ` Try again in ${formatWait(secs)}.`
}

export function getErrorMessage(err, fallback = GENERIC) {
  if (fallback === null || fallback === undefined || fallback === '') fallback = GENERIC
  if (!err) return fallback
  // A deliberately cancelled request is not a connectivity problem.
  if (isCancelError(err)) return fallback

  const res = err.response
  if (res) {
    const data = res.data
    if (data && typeof data === 'object') {
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const parts = data.errors.slice(0, 3).map(e => {
          // An entry with a field but no message used to render "Email: undefined".
          const msg = typeof e?.message === 'string' ? e.message.trim() : ''
          if (!msg) return ''
          const label = humanizeField(e.field)
          return label ? `${label}: ${msg}` : msg
        }).filter(Boolean)
        if (parts.length) return parts.join(' · ')
      }
      // The Worker masks every UNHANDLED 5xx as exactly this text (middleware/errorHandler.js, GENERIC_ERROR_MESSAGE). It says
      // nothing and tells the person nothing to do, so for a 5xx it yields to the friendlier line below. Keep the two in sync.
      const masked = res.status >= 500 && data.message === 'An error occurred.'
      if (typeof data.message === 'string' && data.message && data.message !== 'Validation failed' && !masked) return data.message + waitSentence(err, data.message)
    }
    if (res.status === 429) {
      const base = 'Too many requests — please wait a moment and try again.'
      return waitSentence(err, '') ? 'Too many requests.' + waitSentence(err, '') : base
    }
    if (res.status === 413) return 'That file is too large.'
    // A 503 that says how long it will be (maintenance, overload) tells the person, not just "a problem".
    if (res.status === 503 && getRetryAfterSeconds(err)) return `The service is briefly unavailable. Try again in ${formatWait(getRetryAfterSeconds(err))}.`
    if (res.status >= 500) return 'The server had a problem. Please try again in a moment.'
    return fallback
  }

  // No response at all: distinguish "the network failed" from "our own code threw".
  if (err.isAxiosError || err.request) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      return 'The request timed out. Please check your connection and try again.'
    return "Can't reach the server. Please check your connection and try again."
  }
  return fallback
}

// axios applies `responseType: 'blob'` to ERROR responses too, so a normal JSON
// error body arrives as a Blob and `err.response.data.code` is silently
// undefined. Parse it back into an object, in place, so every consumer (the
// session-expiry logic, getErrorMessage, page code) can treat it normally.
export async function normalizeBlobError(err) {
  const data = err?.response?.data
  if (typeof Blob === 'undefined' || !(data instanceof Blob)) return err
  try {
    err.response.data = JSON.parse(await data.text())
  } catch (_) {
    err.response.data = {}   // not JSON — leave callers with an empty object, not a Blob
  }
  return err
}

// Should a failed request be retried once, automatically?
// Only idempotent GETs, and only for failures that are plausibly transient.
export function shouldRetryRequest({ method, status, hasResponse, retryAfterSeconds, alreadyRetried, cancelled = false }) {
  if (alreadyRetried) return { retry: false }
  // No method means no request config survived (not an axios request error): nothing to replay.
  if (!method || String(method).toLowerCase() !== 'get') return { retry: false }
  // A request the caller aborted on purpose is not a transient failure.
  if (cancelled) return { retry: false }
  if (!hasResponse) return { retry: true, delayMs: 800 }                       // network blip / timeout
  if (status === 502 || status === 503 || status === 504) {
    // A server that says how long to wait (a brief 503) is asked once, after that time, when it is short enough to wait for.
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 5) return { retry: true, delayMs: Math.ceil(retryAfterSeconds * 1000) }
    return { retry: true, delayMs: 800 }
  }
  if (status === 429 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 5)
    return { retry: true, delayMs: Math.ceil(retryAfterSeconds * 1000) }        // only when the server says how long
  return { retry: false }
}
