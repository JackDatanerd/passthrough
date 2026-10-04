// Turns a stored User-Agent string into a short label for the signed-in devices
// list ("Chrome on Windows"). Deliberately tiny and order-sensitive rather than
// a UA database: the list only needs to be recognisable, and an unknown agent
// falls back to a plain label instead of dumping the raw string at the person.
//
// Order matters because UA strings impersonate each other: Edge and Opera
// contain "Chrome", Chrome contains "Safari", Android contains "Linux", and
// iPhone contains "Mac OS X".
export function describeUserAgent(ua) {
  if (!ua || typeof ua !== 'string') return 'Unknown device'
  const browser =
    /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : null
  if (browser && os) return `${browser} on ${os}`
  return browser || os || 'Unknown device'
}
