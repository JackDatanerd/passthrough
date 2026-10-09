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
  let index = null
  while (parts.length && /^\d+$/.test(parts[parts.length - 1])) index = Number(parts.pop())
  const last = parts.pop()
  if (!last) return ''
  const spaced = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1)
  return index === null ? label : `${label} (item ${index + 1})`
}

// True for a request that was aborted on purpose (AbortController / axios cancel).
export function isCancelError(err) {
  return !!err && (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError')
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
      if (typeof data.message === 'string' && data.message && data.message !== 'Validation failed') return data.message
    }
    if (res.status === 429) return 'Too many requests — please wait a moment and try again.'
    if (res.status === 413) return 'That file is too large.'
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
  if (status === 502 || status === 503 || status === 504) return { retry: true, delayMs: 800 }
  if (status === 429 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 && retryAfterSeconds <= 5)
    return { retry: true, delayMs: Math.ceil(retryAfterSeconds * 1000) }        // only when the server says how long
  return { retry: false }
}
