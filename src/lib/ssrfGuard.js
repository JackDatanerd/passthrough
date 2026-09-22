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
// AUDIT FIX (Section 9): the above list used to stop at hostname-string
// checks and call DNS rebinding an accepted, out-of-scope gap. That
// undersold the actual exposure — rebinding (a hostname whose *answer
// changes* between check-time and fetch-time) is one thing, but a hostname
// with a completely ordinary, static A/AAAA record pointing straight at
// 169.254.169.254 needs no rebinding trick at all. Free wildcard-DNS
// services (nip.io, sslip.io — "169.254.169.254.nip.io" resolves to exactly
// that IP, forever, no attacker infrastructure required) made this a
// zero-effort bypass of every check above, since none of them ever looked
// at what a non-literal hostname actually resolves to.
//
// resolveHostnameIsSafe() below closes this: any hostname that isn't
// already a blocked literal is resolved via DNS-over-HTTPS (Cloudflare's
// own resolver — a plain `fetch()` call, no new binding/dependency needed)
// and every returned A/AAAA answer is run back through the exact same
// isPrivateIPv4/isPrivateIPv6 checks used for literal IPs above. This still
// doesn't close true TOCTOU rebinding (an answer that's public at
// check-time and private by the time `fetch()` itself connects) — nothing
// short of resolve-then-connect-to-the-resolved-IP does, and stock Workers
// `fetch()` has no hook for that — but it closes the much larger, much
// easier "just point a hostname at a private IP" class outright.
//
// Fails CLOSED: any DoH lookup failure (timeout, non-2xx, malformed
// response, or a hostname with literally no A/AAAA records) is treated as
// unsafe. This is a security check, not a best-effort feature — an
// inconclusive answer must never be treated as a pass.

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.local', '.internal', '.localdomain', '.lan', '.localhost', '.home.arpa', '.intranet', '.corp',
  // Wildcard-DNS services that resolve "<anything>.<ip>.<service>" to that IP —
  // the cheapest way to smuggle 127.0.0.1 / 169.254.169.254 past a hostname
  // check. Best-effort only (see the DNS-rebinding note above): a determined
  // attacker can run their own wildcard domain.
  '.nip.io', '.sslip.io', '.xip.io', '.localtest.me', '.lvh.me',
]
const BLOCKED_HOSTNAMES = ['localhost']
const DOH_TIMEOUT_MS = 3000

// A job posting is served on the web's standard ports. Refusing everything else
// means this fetcher can't be pointed at a database/cache/admin port on an
// otherwise-public host ("http://example.com:6379/"). '' = the scheme default.
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])

function isIPv4(hostname) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname)
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split('.').map(Number)
  if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed -> reject
  const [a, b, c] = parts
  if (a === 127) return true                          // loopback
  if (a === 10) return true                            // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true      // RFC1918
  if (a === 192 && b === 168) return true               // RFC1918
  if (a === 169 && b === 254) return true               // link-local incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true      // CGNAT
  if (a === 192 && b === 0 && c === 0) return true       // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true       // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true   // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 88 && c === 99) return true     // 192.88.99.0/24 deprecated 6to4 relay anycast
  if (a === 198 && b === 51 && c === 100) return true    // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true     // TEST-NET-3
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

  // Range checks are done on the numeric first group, not string prefixes.
  // The previous `startsWith('fe80')` only covered fe80::/16, but link-local
  // is fe80::/10 (fe80–febf) — fe90::1, fea0::1, febf::1 all slipped through.
  const first = parseInt(h.split(':')[0] || '0', 16)
  if (!Number.isNaN(first)) {
    if ((first & 0xfe00) === 0xfc00) return true          // unique local  fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true          // link-local    fe80::/10
    if ((first & 0xffc0) === 0xfec0) return true          // site-local    fec0::/10 (deprecated)
    if ((first & 0xff00) === 0xff00) return true          // multicast     ff00::/8
    if (first === 0x2002) return true                     // 6to4 2002::/16 — embeds an IPv4, deprecated, never a job board
  }
  if (h.startsWith('2001:0:') || h.startsWith('2001::')) return true  // Teredo 2001::/32 (deprecated tunnel)
  if (h.startsWith('2001:db8:')) return true                           // documentation range

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

  // 2b. IPv4-translated (SIIT, RFC 2765) ::ffff:0:a.b.c.d — canonical hex
  //     form ::ffff:0:hi:lo. Not covered by the plain mapped form above.
  const translatedHex = h.match(/^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (translatedHex) return isPrivateIPv4(decodeEmbeddedIPv4Hex(translatedHex[1], translatedHex[2]))

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

// DNS-over-HTTPS lookup via Cloudflare's own resolver — a plain fetch(),
// nothing new to configure or bind. Returns an array of resolved IP address
// strings (v4 and/or v6, whatever the record type returned), or throws on
// any failure — callers must treat a throw as "unsafe," not "unknown."
async function resolveHostname(hostname) {
  const headers = { Accept: 'application/dns-json' }
  // Bounded: an unresponsive resolver must fail the CHECK (closed — see
  // resolveHostnameIsSafe), not hang the request until the platform kills it.
  const opts = () => ({ headers, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) })
  const [aRes, aaaaRes] = await Promise.all([
    fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,    opts()),
    fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`, opts())
  ])
  if (!aRes.ok || !aaaaRes.ok) throw new Error('DoH lookup failed')

  const [aBody, aaaaBody] = await Promise.all([aRes.json(), aaaaRes.json()])
  const answers = [...(aBody.Answer || []), ...(aaaaBody.Answer || [])]
  // Answer.type 1 = A, 28 = AAAA — skip CNAME/other record types mixed into
  // the same Answer array; .data on those two types is the address itself.
  return answers.filter(a => a.type === 1 || a.type === 28).map(a => a.data)
}

// Resolves hostname and checks every returned address against the same
// private-range logic used for literal IPs. Fails closed: any lookup error,
// or a hostname that resolves to zero addresses, is treated as unsafe —
// silently allowing an unresolvable check through would defeat the point.
async function resolveHostnameIsSafe(hostname) {
  let ips
  try {
    ips = await resolveHostname(hostname)
  } catch (_) {
    return false
  }
  if (ips.length === 0) return false
  return ips.every(ip => (ip.includes(':') ? !isPrivateIPv6(ip) : !isPrivateIPv4(ip)))
}

// Returns null if the URL is safe to fetch, or a user-facing reason string if not.
async function checkUrlIsSafeToFetch(url) {
  let parsed
  try { parsed = new URL(url) } catch (_) { return 'Invalid URL.' }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http/https URLs are supported.'

  // Credentials in a URL have no place in a job link and are a classic way to
  // dress up a request ("https://trusted.com@evil.com/").
  if (parsed.username || parsed.password) return 'That address cannot be fetched.'
  if (!ALLOWED_PORTS.has(parsed.port)) return 'That address cannot be fetched.'

  // Strip trailing dots: "localhost." and "metadata.google.internal." are the
  // same hosts as their dotless forms (fully-qualified DNS names), but the
  // exact-match / endsWith checks below used to miss them entirely.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  if (!hostname) return 'That address cannot be fetched.'
  if (BLOCKED_HOSTNAMES.includes(hostname)) return 'That address cannot be fetched.'
  if (BLOCKED_HOSTNAME_SUFFIXES.some(sfx => hostname.endsWith(sfx))) return 'That address cannot be fetched.'

  if (isIPv4(hostname) && isPrivateIPv4(hostname)) return 'That address cannot be fetched.'
  if (hostname.includes(':') && isPrivateIPv6(hostname)) return 'That address cannot be fetched.'
  if (hostname === '0') return 'That address cannot be fetched.'
  // Any purely numeric host that survived URL normalisation is malformed/exotic.
  if (/^[0-9.]+$/.test(hostname) && !isIPv4(hostname)) return 'That address cannot be fetched.'

  // Hostname is already a literal IP (checked above, and either passed or
  // this function already returned) — no DNS resolution needed/possible.
  if (isIPv4(hostname) || hostname.includes(':')) return null

  // Non-literal hostname: resolve it and check what it actually points at.
  const safe = await resolveHostnameIsSafe(hostname)
  if (!safe) return 'That address cannot be fetched.'

  return null
}

module.exports = { checkUrlIsSafeToFetch, isPrivateIPv4, isPrivateIPv6 }
