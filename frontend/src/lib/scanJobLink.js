// What can be said about a job link before the scan is sent. The server refuses LinkedIn and Facebook-family hosts
// (src/services/jd.parser.js BLOCKED, matched as the host or a subdomain of it), and only web addresses can be read at all.
// Said here, the person learns it while typing instead of after pressing the button. Keep BLOCKED in step by hand.
const BLOCKED = ['linkedin.com', 'lnkd.in', 'facebook.com', 'fb.com', 'instagram.com']

// 'empty' | 'bad' | 'blocked' | 'ok'
export function classifyJobLink(raw) {
  const text = String(raw || '').trim()
  if (!text) return 'empty'
  let url
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`) } catch (_) { return 'bad' }
  if (!/^https?:$/.test(url.protocol)) return 'bad'
  const host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (!host.includes('.') || /\s/.test(text)) return 'bad'
  return BLOCKED.some(d => host === d || host.endsWith(`.${d}`)) ? 'blocked' : 'ok'
}
