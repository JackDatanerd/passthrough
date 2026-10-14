import { resolveApiBase } from './apiUrl'
import { isCancelError } from './errors'

// Tells the Worker when a page crashes in someone's browser (POST /api/client-errors -> an owner alert). Until this existed a
// render crash, an uncaught error or a lazy chunk that would not load was only a console.error on the visitor's own machine.
//
// Deliberately NOT built on lib/api.js: that client's interceptors can redirect, retry and prompt, and a failure inside the
// reporter must never be able to cause another report (a loop) or move the person anywhere. This is one plain fetch that
// swallows every failure, sends nothing identifying (no token, no cookies, no device id) and never throws.
//
// Noise is cut at the source as well as at the server: a handful of reports per page load at most, never the same error
// twice, and nothing for the things that are not our bugs (a cancelled request, a browser extension's code, an offline
// device, "ResizeObserver loop", an opaque cross-origin "Script error.").

const MAX_REPORTS_PER_PAGE = 5
const seen = new Set()
let sent = 0

const EXTENSION = /(?:chrome|moz|safari(?:-web)?)-extension:\/\/|webkit-masked-url:\/\//i
const CHUNK = /Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i
const BENIGN = /ResizeObserver loop|^Script error\.?$|Non-Error promise rejection captured/i

function text(v, max) {
  const s = typeof v === 'string' ? v : ''
  return s.length > max ? s.slice(0, max) : s
}

// The entry script's file name (assets/index-<hash>.js) tells which deploy this tab is running — the first question when
// a flood of the same error starts right after a release. Nothing else about the page is sent.
function buildId() {
  try {
    const src = document.querySelector('script[type="module"][src]')?.getAttribute('src') || ''
    const m = /assets\/[\w.-]+\.js/.exec(src)
    return m ? m[0] : ''
  } catch (_) { return '' }
}

export function classify(error, requested) {
  if (requested === 'render' || requested === 'unhandledrejection') {
    return CHUNK.test(String(error?.message || error || '')) ? 'chunk' : requested
  }
  return CHUNK.test(String(error?.message || error || '')) ? 'chunk' : (requested || 'error')
}

// Whether this error is worth a report at all.
export function shouldReport(error) {
  if (!error) return false
  if (isCancelError(error)) return false
  if (error.isAxiosError) return false                                  // a failed API call: the Worker already knows, and the page shows its own message
  const message = String(error.message ?? error)
  if (!message || BENIGN.test(message)) return false
  if (EXTENSION.test(String(error.stack || '')) && !/\/assets\//.test(String(error.stack || ''))) return false   // thrown by an extension, not by us
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false       // offline: a chunk or fetch failure says nothing about the app
  return true
}

export function reportClientError(kind, error, extra = {}) {
  try {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false
    if (!shouldReport(error)) return false
    const message = text(String(error?.message ?? error), 500)
    const stack = text(typeof error?.stack === 'string' ? error.stack : '', 3000)
    const finalKind = classify(error, kind)
    const key = `${finalKind}|${message.split('\n')[0].replace(/\d+/g, '#')}|${(stack.split('\n')[1] || '').replace(/\d+/g, '#')}`
    if (seen.has(key) || sent >= MAX_REPORTS_PER_PAGE) return false
    seen.add(key); sent++
    const body = JSON.stringify({
      kind: finalKind,
      message,
      stack,
      componentStack: text(extra.componentStack, 1500),
      path: window.location.pathname,          // never the query string or hash: either can carry a token
      build: buildId(),
    })
    fetch(`${resolveApiBase(import.meta.env.VITE_API_URL)}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {})
    return true
  } catch (_) {
    return false
  }
}

// window-level listeners for what the error boundary cannot see: an uncaught error in an event handler or timer, and a
// promise that rejected with nobody listening. Returns a function that removes them (tests, hot reload).
export function installGlobalErrorReporting() {
  if (typeof window === 'undefined') return () => {}
  const onError = e => reportClientError('error', e?.error || { message: e?.message, stack: '' })
  const onRejection = e => reportClientError('unhandledrejection', e?.reason)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
}

// For tests.
export function resetErrorReporting() { seen.clear(); sent = 0 }
