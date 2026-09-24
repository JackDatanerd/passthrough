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

// Limiter bucket for an IP. An IPv6 subscriber controls an entire /64 (often
// far more), so keying on the full address lets one client mint unlimited
// "different" IPs and walk around every per-IP limit. Collapse IPv6 to its
// /64 prefix; IPv4 (and IPv4-mapped IPv6) is unchanged.
//
// `bits` (64 default, or 48) is how much of the address the bucket keys on. The
// public verify lookups pass 48: a /64 is what one home connection gets, but a
// free tunnel-broker or any hosting plan hands out a /48 (65,536 separate /64s),
// which made a per-/64 enumeration brake trivially walkable by one actor.
function rateKeyIp(ip, bits = 64) {
  if (!ip || ip === 'unknown' || !ip.includes(':')) return ip || 'unknown'
  const h = ip.toLowerCase().split('%')[0]
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (mapped) return mapped[1]
  if (h.includes('.')) return h
  const [head, tail] = h.split('::')
  const headParts = head ? head.split(':') : []
  let groups
  if (h.includes('::')) {
    const tailParts = tail ? tail.split(':') : []
    const missing = 8 - headParts.length - tailParts.length
    groups = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts]
  } else {
    groups = headParts
  }
  if (groups.length !== 8) return h
  const keep = bits === 48 ? 3 : 4
  return groups.slice(0, keep).map(g => g.padStart(4, '0')).join(':') + `::/${keep * 16}`
}

module.exports = { clientIp, rateKeyIp }
