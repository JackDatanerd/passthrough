// Helpers for POST /api/client-errors — the SPA telling the Worker "a page crashed in someone's browser".
//
// Everything in a report is written by a browser, so none of it is trusted: it is clipped, scrubbed of anything that
// looks like a credential or an address, and only ever shown as text. A person's session can be in the URL (?token=,
// /v/<code>, /scan/<id>) or in an error message (a failed fetch quoting its URL), and none of that belongs in an alert
// email or in alert_logs.

const KINDS = new Set(['render', 'error', 'unhandledrejection', 'chunk'])

const LIMITS = { message: 500, stack: 3000, componentStack: 1500, path: 200, build: 80 }

function clip(value, max) {
  if (typeof value !== 'string') return ''
  const s = value.replace(/\u0000/g, '').trim()
  return s.length > max ? s.slice(0, max) : s
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// A page address with the parts that identify a person or a document taken out: ids, verification codes, long opaque
// segments. Query string and hash are dropped entirely.
function normalizePath(input) {
  let p = clip(String(input == null ? '' : input), LIMITS.path)
  p = p.split(/[?#]/)[0]
  if (!p.startsWith('/')) p = `/${p}`
  const parts = p.split('/').map((seg, i, all) => {
    if (!seg) return seg
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id'
    if (all[i - 1] === 'v') return ':code'                     // /v/<verification code>
    if (seg.length >= 20 && /^[\w-]+$/.test(seg)) return ':token'
    if (/^\d{4,}$/.test(seg)) return ':id'
    return seg
  })
  return parts.join('/') || '/'
}

// Free text (a message, a stack) with credentials and addresses replaced by a marker.
function redactText(input) {
  let s = typeof input === 'string' ? input : ''
  s = s.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{0,}/g, '[jwt]')                          // a session / signed token
  s = s.replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [redacted]')
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
  s = s.replace(UUID, '[id]')
  // ?token=… / &code=… / password=… wherever it appears (a URL quoted in a message, a stack frame)
  s = s.replace(/([?&;]|\b)(token|code|ref|key|secret|password|pass|auth|session|sid|email|api[_-]?key)=([^\s&#)'"]*)/gi, '$1$2=[redacted]')
  // …and any query string or fragment left on an address
  s = s.replace(/(https?:\/\/[^\s?#)'"]+)[?#][^\s)'"]*/g, '$1')
  // a long unbroken run of token-like characters (a code, a key) that survived the rules above
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[token]')
  return s
}

// Same error -> same fingerprint, however many browsers hit it: kind + page (normalized) + the message with its
// variable parts (numbers, ids) flattened. Stack frames are left out on purpose — their file names change on every deploy.
function fingerprintInput({ kind, path, message }) {
  const flat = String(message || '').split('\n')[0].replace(/\d+/g, '#').slice(0, 200)
  return `${kind}|${path}|${flat}`
}

// -> { kind, message, stack, componentStack, path, build } or null when there is nothing worth reporting.
function sanitizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const message = redactText(clip(body.message, LIMITS.message))
  if (!message) return null
  return {
    kind: KINDS.has(body.kind) ? body.kind : 'error',
    message,
    stack: redactText(clip(body.stack, LIMITS.stack)),
    componentStack: redactText(clip(body.componentStack, LIMITS.componentStack)),
    path: normalizePath(body.path),
    // a build id is a file name such as assets/index-AbC123.js — nothing else is accepted
    build: /^[\w./-]{1,80}$/.test(clip(body.build, LIMITS.build)) ? clip(body.build, LIMITS.build) : '',
  }
}

function formatAlert(report) {
  const lines = [
    'A browser reported this error. The text comes from the visitor\'s browser and is unverified.',
    '',
    `kind:  ${report.kind}`,
    `page:  ${report.path}`,
  ]
  if (report.build) lines.push(`build: ${report.build}`)
  lines.push('', `message: ${report.message}`)
  if (report.stack) lines.push('', 'stack:', report.stack)
  if (report.componentStack) lines.push('', 'component stack:', report.componentStack)
  return lines.join('\n')
}

module.exports = { KINDS, LIMITS, clip, normalizePath, redactText, fingerprintInput, sanitizeReport, formatAlert }
