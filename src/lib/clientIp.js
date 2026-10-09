// Client-IP helpers shared by the rate limiter, the login lockout and the
// scan-quota bypass check. Kept in its own module (not in
// middleware/rateLimiter.js) so controllers can use it without dragging the
// whole limiter module in.

// The requester's IP. On Cloudflare `cf-connecting-ip` is always set by the
// edge and cannot be supplied by the client. `x-forwarded-for` IS client-
// controlled, so it is only honoured outside production (local dev/tests,
// where there is no edge to set the real header). In production a request
// with no cf-connecting-ip (e.g. one arriving through a service binding)
// shares the single 'unknown' bucket rather than letting a spoofed header
// pick its own bucket — or, worse, impersonate an entry on the bypass list.
function clientIp(c) {
  const header = c && c.req && typeof c.req.header === 'function' ? n => c.req.header(n) : () => undefined
  const cf = header('cf-connecting-ip')
  if (cf) return String(cf).trim()
  const nodeEnv = c && c.env && c.env.NODE_ENV
  if (nodeEnv && nodeEnv !== 'production') {
    const xff = header('x-forwarded-for')
    if (xff) return String(xff).split(',')[0].trim()
  }
  return 'unknown'
}

// Expands an IPv6 literal (lowercase, no zone, optional dotted-quad tail) to its eight 1-4 digit hex
// groups, or null when it is not a well-formed address. Shared by rateKeyIp and isIpLiteral so both
// agree on what an address is.
function expandIPv6(h) {
  let s = h
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (dotted) {
    const o = dotted.slice(1).map(Number)
    if (o.some(n => n > 255)) return null
    s = `${s.slice(0, dotted.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  let groups
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : []
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups
}

// Limiter bucket for an IP. An IPv6 subscriber controls an entire /64 (often
// far more), so keying on the full address lets one client mint unlimited
// "different" IPs and walk around every per-IP limit. Collapse IPv6 to its
// /64 prefix; IPv4 (and IPv4-mapped IPv6, in either spelling) is unchanged.
//
// `bits` (64 default, or 48) is how much of the address the bucket keys on. The
// public verify lookups pass 48: a /64 is what one home connection gets, but a
// free tunnel-broker or any hosting plan hands out a /48 (65,536 separate /64s),
// which made a per-/64 enumeration brake trivially walkable by one actor.
function rateKeyIp(ip, bits = 64) {
  if (!ip || ip === 'unknown' || !ip.includes(':')) return ip || 'unknown'
  const h = ip.toLowerCase().split('%')[0]
  const groups = expandIPv6(h)
  if (!groups) return h
  const n = groups.map(g => parseInt(g, 16))
  // IPv4-mapped (::ffff:a.b.c.d) is an IPv4 client. The hex spelling (::ffff:a00:1) used to fall
  // through to the /64 collapse below, putting EVERY such client — and ::1 — in one shared bucket.
  if (n.slice(0, 5).every(x => x === 0) && n[5] === 0xffff)
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.')
  const keep = bits === 48 ? 3 : 4
  return groups.slice(0, keep).map(g => g.padStart(4, '0')).join(':') + `::/${keep * 16}`
}

// True for a well-formed IPv4 or IPv6 literal (brackets tolerated). Used to vet operator-supplied lists
// such as ADMIN_ALLOWED_IPS — a CIDR range or a typo matches nothing, and the caller wants to say so.
function isIpLiteral(value) {
  const v = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase()
  if (!v) return false
  if (!v.includes(':')) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
    return !!m && m.slice(1).every(x => Number(x) <= 255)
  }
  return expandIPv6(v.split('%')[0]) !== null
}

// Splits a comma-separated operator list into the entries that are IP literals and the ones that are not.
function parseIpList(raw) {
  const entries = String(raw || '').split(',').map(x => x.trim()).filter(Boolean)
  return { valid: entries.filter(isIpLiteral), invalid: entries.filter(x => !isIpLiteral(x)) }
}

module.exports = { clientIp, rateKeyIp, isIpLiteral, parseIpList }
