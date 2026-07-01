// Replaces axios with native fetch. Workers don't have axios's automatic
// timeout/maxContentLength options, so both are implemented manually:
// AbortController for the 5s timeout, a manual byte-length check while
// reading the body for the 500KB cap.

const BLOCKED = ['linkedin.com', 'www.linkedin.com', 'facebook.com', 'instagram.com']
const MAX_BYTES = 500_000

async function fetchJobDescriptionFromUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch (_) {
    return { success: false, blocked: false, text: null, message: 'Invalid URL.' }
  }
  if (BLOCKED.some(d => parsed.hostname.includes(d)))
    return {
      success: false, blocked: true, text: null,
      message: 'LinkedIn blocks automated reading. Paste the job description instead.'
    }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Passthrough/1.0)' },
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return { success: false, blocked: false, text: null, message: 'Could not read that page. Paste instead.' }
    }

    // Manual size cap — fetch has no maxContentLength option
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) {
      return { success: false, blocked: false, text: null, message: 'Page too large. Paste manually.' }
    }
    const html = new TextDecoder().decode(buf)

    const text = (html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!text || text.length < 100)
      return { success: false, blocked: false, text: null,
        message: 'Could not extract text. Paste manually.' }
    return { success: true, blocked: false, text: text.slice(0, 5000) }
  } catch (_) {
    clearTimeout(timeout)
    return { success: false, blocked: false, text: null,
      message: 'Could not read that page. Paste instead.' }
  }
}

module.exports = { fetchJobDescriptionFromUrl }
