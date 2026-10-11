// The ONLY remote hosts a rendered resume page may load from: the web-font CDN pair the AI layout
// prompt asks for. Shared by the HTML sanitizer (claude.service.js, which strips everything else
// before render) and the PDF renderer (pdf.service.js, which refuses every other request at the
// browser itself) so the two layers can never drift apart.
const ALLOWED_RESOURCE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']

function isAllowedResourceUrl(url) {
  try {
    const u = new URL(url, 'https://invalid.example/')
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    return ALLOWED_RESOURCE_HOSTS.includes(u.hostname.toLowerCase())
  } catch (_) {
    return false
  }
}

// A request the render session may make: inline data/blob content never touches the network, and
// about:blank is the page itself. Anything else must be an allowlisted font host.
function isAllowedRenderRequest(url) {
  const u = String(url || '')
  if (u === 'about:blank' || /^data:/i.test(u)) return true
  return isAllowedResourceUrl(u)
}

module.exports = { ALLOWED_RESOURCE_HOSTS, isAllowedResourceUrl, isAllowedRenderRequest }
