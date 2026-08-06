// SSRF guard for any server-side fetch() driven by a user-supplied URL
// (currently: jd.parser.js's "paste a job posting URL" path).
//
// Threat: createScan lets an unauthenticated user hand the server a URL and
// the server fetches it. Without this guard, that's a general-purpose
// SSRF primitive — an attacker can point it at private/internal
// addresses (RFC1918, loopback, link-local incl. cloud metadata at
// 169.254.169.254), non-http(s) schemes, or an external URL that later
// 302s somewhere internal.
//
// What this DOES protect against:
//   - non-http(s) schemes (file:, ftp:, data:, etc.)
//   - IP-literal targets in any private/loopback/link-local/reserved range
//   - "localhost" and common internal-only hostname suffixes
//   - redirect chains that hop into any of the above (fetch is called with
//     redirect:'manual' by the caller and each Location is re-validated
//     here before being followed)
//
// What this DOES NOT protect against:
//   - DNS rebinding, i.e. a public-looking hostname whose DNS record
//     resolves to a private IP at request time. Closing that fully
//     requires resolving DNS yourself and connecting to the resolved IP
//     (not just the hostname), which stock Workers `fetch()` doesn't give
//     you a hook for. If this ever becomes a real threat model concern,
//     the fix is a DNS-over-HTTPS pre-resolve + IP allowlist check before
//     the fetch, or moving this fetch behind a proxy that supports it.
//     Flagging this honestly rather than claiming full coverage.

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localdomain', '.lan']
const BLOCKED_HOSTNAMES = ['localhost']

function isIPv4(hostname) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed -> reject
  const [a, b] = parts
  if (a === 127) return true                          // loopback
  if (a === 10) return true                            // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true      // RFC1918
  if (a === 192 && b === 168) return true               // RFC1918
  if (a === 169 && b === 254) return true               // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true      // CGNAT
  if (a === 0) return true                              // "this network"
  if (a >= 224) return true                              // multicast + reserved (224-255)
  return false
}

// Decodes the two trailing hex16 groups of an IPv6 address's tail into a
// dotted-decimal IPv4 string, e.g. "7f00:1" -> "127.0.0.1". Shared by every
// IPv6 transition form below that embeds an IPv4 address in its low 32 bits.
function decodeEmbeddedIPv4Hex(hi, lo) {
  const hiN = parseInt(hi, 16), loN = parseInt(lo, 16)
  return [(hiN >> 8) & 0xff, hiN & 0xff, (loN >> 8) & 0xff, loN & 0xff].join('.')
}

function isPrivateIPv6(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1') return true                          // loopback
  if (h === '::') return true                            // unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true   // unique local (fc00::/7)
  if (h.startsWith('fe80')) return true                  // link-local

  // IPv6 TRANSITION FORMS: multiple standardized encodings embed an IPv4
  // address inside an IPv6 literal, and each is a documented, actively-used
  // SSRF bypass technique when the embedded address is private/metadata and
  // the requesting network's stack (or an intermediate NAT64/DNS64 gateway)
  // actually resolves/routes the transition form to that embedded IPv4 —
  // this exact class of bug has multiple 2026 CVEs across unrelated
  // codebases. Rather than allowlist-checking each wrapper form's own
  // "is this range private" table (easy to leave a gap, as the IPv4-mapped
  // case below already did once), every form is normalized down to its
  // embedded dotted-decimal IPv4 and re-checked through isPrivateIPv4 —
  // one source of truth for "is this IP private," regardless of which IPv6
  // wrapper it arrived in.

  // 1. IPv4-mapped (::ffff:a.b.c.d) — literal dotted-decimal spelling, e.g.
  //    what a user types directly.
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1])

  // 2. IPv4-mapped, canonical hex form. The WHATWG URL parser (what
  //    `new URL()` uses, both here and in jd.parser.js before this function
  //    ever sees the hostname) canonicalizes an IPv4-mapped address to
  //    compressed hex groups instead of preserving the dotted-decimal form
  //    — e.g. `[::ffff:127.0.0.1]` becomes hostname `[::ffff:7f00:1]`, and
  //    `[::ffff:169.254.169.254]` (cloud metadata) becomes
  //    `[::ffff:a9fe:a9fe]`. Confirmed against both loopback and the
  //    169.254.169.254 metadata address.
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) return isPrivateIPv4(decodeEmbeddedIPv4Hex(mappedHex[1], mappedHex[2]))

  // 3. IPv4-compatible (deprecated but still parsed) — ::a.b.c.d or its
  //    canonical hex equivalent ::hi:lo, with no "ffff" marker group.
  const compatDotted = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (compatDotted) return isPrivateIPv4(compatDotted[1])
  const compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (compatHex) return isPrivateIPv4(decodeEmbeddedIPv4Hex(compatHex[1], compatHex[2]))

  // 4. NAT64 well-known prefix (RFC 6052, 64:ff9b::/96) and the RFC 8215
  //    local-use prefix (64:ff9b:1::/48). On a network behind a NAT64/DNS64
  //    gateway — including some IPv6-only Kubernetes/cloud setups — these
  //    literally route to the embedded IPv4. `64:ff9b::a9fe:a9fe` and
  //    `64:ff9b:1::a9fe:a9fe` both encode 169.254.169.254.
  const nat64 = h.match(/^64:ff9b(?::1)?::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (nat64) return isPrivateIPv4(decodeEmbeddedIPv4Hex(nat64[1], nat64[2]))

  return false
}

// Returns null if the URL is safe to fetch, or a user-facing reason string if not.
function checkUrlIsSafeToFetch(url) {
  let parsed
  try { parsed = new URL(url) } catch (_) { return 'Invalid URL.' }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http/https URLs are supported.'

  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.includes(hostname)) return 'That address cannot be fetched.'
  if (BLOCKED_HOSTNAME_SUFFIXES.some(sfx => hostname.endsWith(sfx))) return 'That address cannot be fetched.'

  if (isIPv4(hostname) && isPrivateIPv4(hostname)) return 'That address cannot be fetched.'
  if (hostname.includes(':') && isPrivateIPv6(hostname)) return 'That address cannot be fetched.'
  if (hostname === '0') return 'That address cannot be fetched.'

  return null
}

module.exports = { checkUrlIsSafeToFetch, isPrivateIPv4, isPrivateIPv6 }
