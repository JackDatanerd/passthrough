// Phase 5 — platform-specific hardening for job description URL fetching.
// Deliberately scoped to what's safe and honest to do without a real DOM
// parser: all functions here operate on TEXT that's already been flattened
// by jd.parser.js's generic tag-stripping, never on raw nested HTML. Trying
// to regex-match "the div with class X and everything nested inside it" on
// raw markup is the classic you-can't-parse-HTML-with-regex trap (unclosed
// tags, attribute order, nesting depth all break it); operating on flattened
// text sidesteps that entirely, at the cost of only being able to remove
// boilerplate that's identifiable by its own words, not its markup
// structure. That's an intentional trade — this file adds no new
// dependency, matching the project's existing preference (jd.parser.js
// itself was ported from axios to native fetch specifically to avoid one).
//
// Workday gets fundamentally different treatment than Greenhouse/Lever, for
// a real architectural reason, not an oversight: Workday job postings are
// client-side rendered. A plain fetch() typically returns a near-empty HTML
// shell, with the actual job text loaded afterward via a separate API call
// this module has no way to replicate. There is no boilerplate to strip
// because the content usually isn't in the response at all — so rather than
// pretend to harden against it, this module detects the failure and lets
// the caller return an honest, specific error instead of a generic one.

const GREENHOUSE_HOSTS = ['greenhouse.io']
const LEVER_HOSTS      = ['lever.co']
const WORKDAY_HOSTS    = ['myworkdayjobs.com']

function hostMatches(hostname, list) {
  return list.some(h => hostname === h || hostname.endsWith('.' + h))
}

/**
 * True if this hostname belongs to a platform known to render job content
 * client-side, where a plain fetch() is architecturally unlikely to see the
 * actual posting text. Callers should use this to attribute a post-fetch
 * "text too short" failure correctly, rather than assume the same generic
 * parsing failure every other site can hit.
 */
function isKnownUnreliablePlatform(hostname) {
  return hostMatches(hostname, WORKDAY_HOSTS)
}

// On both Greenhouse and Lever, this boilerplate reliably appears AFTER the
// real job description content — the EEO/demographic self-identification
// survey and the application form are always further down the page, never
// interleaved within the posting text itself. That ordering guarantee is
// what makes "find the earliest anchor phrase and cut everything from there
// onward" a safe operation: it can only ever remove trailing noise, never
// truncate real content that appears before it.
const ANCHOR_PHRASES = [
  'voluntary self-identification',
  'equal employment opportunity',
  'we are an equal opportunity employer',
  'section 503 of the rehabilitation act',
  'pursuant to the san francisco fair chance ordinance',
]

function truncateAtFirstAnchor(text) {
  const lower = text.toLowerCase()
  let cutAt = text.length
  for (const phrase of ANCHOR_PHRASES) {
    const idx = lower.indexOf(phrase)
    if (idx !== -1 && idx < cutAt) cutAt = idx
  }
  return text.slice(0, cutAt).trim()
}

// Short, isolated noise that survives generic tag-stripping — these were
// originally <label>/<button>/<input placeholder> text with no surrounding
// block structure worth targeting even with a real DOM parser. Safe to
// strip anywhere they appear, unlike the anchor-based truncation above,
// since they're never part of genuine job description prose.
const FORM_FIELD_PATTERNS = [
  /\bindicates a required field\b/gi,
  /\bfirst name\s*\*?/gi,
  /\blast name\s*\*?/gi,
  /\bresume\/cv\s*\*?/gi,
  /\bcover letter\s*\*?/gi,
  /\bshare this job\b/gi,
  /\bapply for this job\s*\*?/gi,
  /\bpowered by greenhouse\b/gi,
]

function stripFormFieldNoise(text) {
  let out = text
  for (const pattern of FORM_FIELD_PATTERNS) out = out.replace(pattern, ' ')
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * stripPlatformBoilerplate(hostname, text) -> cleaned text
 * No-op for any hostname that isn't Greenhouse or Lever — Workday is
 * handled separately via isKnownUnreliablePlatform() above, and every
 * other site keeps the existing generic-only stripping it already had.
 */
function stripPlatformBoilerplate(hostname, text) {
  if (!hostMatches(hostname, GREENHOUSE_HOSTS) && !hostMatches(hostname, LEVER_HOSTS))
    return text
  return stripFormFieldNoise(truncateAtFirstAnchor(text))
}

module.exports = { stripPlatformBoilerplate, isKnownUnreliablePlatform }
