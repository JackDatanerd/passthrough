// Replaces axios with native fetch. Workers don't have axios's automatic
// timeout/maxContentLength options, so both are implemented manually:
// AbortController for the 5s timeout, a manual byte-length check while
// reading the body for the 500KB cap.

const BLOCKED = ['linkedin.com', 'www.linkedin.com', 'facebook.com', 'instagram.com']
const MAX_BYTES = 500_000
const MAX_REDIRECTS = 3
const { stripPlatformBoilerplate, isKnownUnreliablePlatform } = require('./jdBoilerplate')
const { checkUrlIsSafeToFetch } = require('../lib/ssrfGuard')

// Reads a Response body via its stream, aborting the moment the accumulated
// byte count crosses maxBytes rather than buffering the entire thing first.
// Returns the decoded text, or null if the cap was exceeded. Falls back to
// the old buffer-then-check approach only if res.body isn't a stream for
// some reason (shouldn't happen on Workers' fetch, but fails safe rather
// than throwing).
async function readCappedText(res, maxBytes) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) return null
    return new TextDecoder().decode(buf)
  }

  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

// SSRF-safe fetch: validates the target before every request AND before
// following each redirect hop (redirect:'manual' so we control that).
// A prior blocklist-only check validated the ORIGINAL url and then let
// fetch() auto-follow redirects wherever they pointed — a public-looking
// URL that 302s to a private/internal address sailed straight through.
async function safeFetch(url, opts) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const reason = await checkUrlIsSafeToFetch(current)
    if (reason) return { blocked: true, reason }

    const res = await fetch(current, { ...opts, redirect: 'manual' })
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location')
    if (!isRedirect) return { blocked: false, res }

    current = new URL(res.headers.get('location'), current).toString()
  }
  return { blocked: true, reason: 'Too many redirects.' }
}

// Detects job-board CATEGORY/LISTING pages (e.g. "Physics Jobs" showing 35
// different postings) as opposed to a single job's description page. This
// matters because nothing else in this pipeline catches it: a listing page
// has real, substantial text content — it's not blocked, not too short,
// not client-side-rendered — it's just the WRONG kind of content. Scraping
// it as "the JD" silently feeds keyword extraction a mix of navigation,
// filter UI, ad copy, and a dozen unrelated job blurbs, which produces a
// keyword score that reflects nothing real about resume/JD fit.
//
// Requires 2+ independent signals to fire, specifically to avoid false-
// positiving on a real single JD that happens to mention a pay range more
// than once (e.g. different seniority tiers) — verified against both a
// real listing page (4 signals fired) and a real single job posting (0
// signals fired) before shipping.
function looksLikeListingPage(text) {
  const signals = []
  if (/\b\d{1,4}\s+jobs?\s+(available|found|listed|open|results)\b/i.test(text)) signals.push('job-count phrase')
  if (/page\s+\d+\s+of\s+\d+/i.test(text)) signals.push('pagination')
  const payRangeMatches = text.match(/\$\d{1,4}[\s-]*(?:–|-|to)\s*\$?\d{1,4}\s*\/?\s*(?:hr|hour|task)?/gi) || []
  if (payRangeMatches.length >= 4) signals.push(`${payRangeMatches.length} pay-range mentions`)
  if (/sort\s+by\s*:?\s*(featured|newest|highest pay)/i.test(text)) signals.push('sort-by UI')
  return signals.length >= 2
}

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
    const fetched = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Passthrough/1.0)' },
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (fetched.blocked) {
      return { success: false, blocked: false, text: null, message: 'Could not read that page. Paste instead.' }
    }
    const res = fetched.res

    if (!res.ok) {
      return { success: false, blocked: false, text: null, message: 'Could not read that page. Paste instead.' }
    }

    // Manual size cap — fetch has no maxContentLength option. This reads the
    // body as a stream and aborts as soon as the cap is crossed, rather than
    // buffering the whole response with res.arrayBuffer() first and checking
    // afterward — the previous version paid the full memory/CPU cost of an
    // oversized body from a malicious or compromised target before the check
    // ever ran, which is a minor DoS surface on an endpoint anonymous users
    // can hit.
    const html = await readCappedText(res, MAX_BYTES)
    if (html === null) {
      return { success: false, blocked: false, text: null, message: 'Page too large. Paste manually.' }
    }

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

    if (looksLikeListingPage(text)) {
      return { success: false, blocked: true, text: null,
        message: 'This looks like a job listing/category page with multiple postings, not a single job description. Please paste the URL of the specific job, or paste its description text directly.' }
    }

    return { success: true, blocked: false, text: text.slice(0, 5000) }
  } catch (_) {
    clearTimeout(timeout)
    return { success: false, blocked: false, text: null,
      message: 'Could not read that page. Paste instead.' }
  }
}

module.exports = { fetchJobDescriptionFromUrl }
