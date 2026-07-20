// Replaces axios with native fetch. Workers don't have axios's automatic
// timeout/maxContentLength options, so both are implemented manually:
// AbortController for the 5s timeout, a manual byte-length check while
// reading the body for the 500KB cap.

const BLOCKED = ['linkedin.com', 'www.linkedin.com', 'facebook.com', 'instagram.com']
const MAX_BYTES = 500_000
const { stripPlatformBoilerplate, isKnownUnreliablePlatform } = require('./jdBoilerplate')

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

    // PHASE 5: generic flatten first (unchanged from before this phase),
    // then platform-specific boilerplate removal — which must run BEFORE
    // the length check and the 5000-char slice below. Stripping after
    // slicing risks either cutting off real content that was pushed past
    // 5000 chars by boilerplate ahead of it, or leaving a truncated
    // boilerplate fragment behind. Doing it here, on the full flattened
    // text, avoids both.
    let text = (html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    text = stripPlatformBoilerplate(parsed.hostname, text)

    if (!text || text.length < 100) {
      // PHASE 5: Workday renders job content client-side — a plain fetch()
      // typically gets back a near-empty shell, which is architecturally
      // different from every other site hitting this same length check for
      // an unrelated reason (a genuinely thin page, a fetch that succeeded
      // but returned junk, etc.). Attribute the failure correctly instead
      // of returning the same generic message for a fundamentally
      // different cause. blocked:true is reused deliberately here — the
      // frontend already switches back to paste-mode on that flag (same
      // handling LinkedIn's outright block uses), which is exactly the
      // right UX for "please paste this one manually" even though the
      // underlying reason (client-side rendering, not hostility) differs
      // from LinkedIn's.
      if (isKnownUnreliablePlatform(parsed.hostname))
        return { success: false, blocked: true, text: null,
          message: "This looks like a Workday job posting — these often load content dynamically and can't be read automatically. Paste the job description text instead." }
      return { success: false, blocked: false, text: null,
        message: 'Could not extract text. Paste manually.' }
    }
    return { success: true, blocked: false, text: text.slice(0, 5000) }
  } catch (_) {
    clearTimeout(timeout)
    return { success: false, blocked: false, text: null,
      message: 'Could not read that page. Paste instead.' }
  }
}

module.exports = { fetchJobDescriptionFromUrl }
