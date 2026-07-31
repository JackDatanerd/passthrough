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

function isPrivateIPv6(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1') return true                          // loopback
  if (h === '::') return true                            // unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true   // unique local (fc00::/7)
  if (h.startsWith('fe80')) return true                  // link-local
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isPrivateIPv4(mapped[1])
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
