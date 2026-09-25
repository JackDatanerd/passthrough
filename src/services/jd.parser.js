// Replaces axios with native fetch. Workers don't have axios's automatic
// timeout/maxContentLength options, so both are implemented manually:
// AbortController for the 5s timeout, a manual byte-length check while
// reading the body for the 500KB cap.

const BLOCKED = ['linkedin.com', 'lnkd.in', 'facebook.com', 'fb.com', 'instagram.com']

// Exact host or a real subdomain of it. The old check was
// `hostname.includes(d)`, which also blocked unrelated employers whose domain
// merely CONTAINS one of these strings (e.g. notlinkedin.com, myfacebook.com).
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.+$/, '')
  return BLOCKED.some(d => h === d || h.endsWith('.' + d))
}
const MAX_BYTES = 500_000
const MAX_REDIRECTS = 3
const { stripPlatformBoilerplate, isKnownUnreliablePlatform } = require('./jdBoilerplate')
const { checkUrlIsSafeToFetch } = require('../lib/ssrfGuard')
const { decodeHtmlEntities } = require('../lib/htmlEntities')

// Reads a Response body via its stream, aborting the moment the accumulated
// byte count crosses maxBytes rather than buffering the entire thing first.
// Returns the decoded text, or null if the cap was exceeded. Falls back to
// the old buffer-then-check approach only if res.body isn't a stream for
// some reason (shouldn't happen on Workers' fetch, but fails safe rather
// than throwing).
function charsetOf(res) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(res.headers?.get?.('content-type') || '')
  return m ? m[1] : 'utf-8'
}

// The declared charset is honoured (a windows-1252 page decoded as UTF-8
// turns every curly quote/accent into mojibake); an unknown label falls back
// to UTF-8 instead of throwing.
function decoderFor(charset) {
  try { return new TextDecoder(charset) } catch (_) { return new TextDecoder() }
}

async function readCappedText(res, maxBytes) {
  const decoder = decoderFor(charsetOf(res))
  const reader = res.body?.getReader?.()
  if (!reader) {
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) return null
    return decoder.decode(buf)
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
  return decoder.decode(merged)
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
    // Free the connection instead of leaving an unread redirect body open.
    try { await res.body?.cancel?.() } catch (_) {}

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

// ── Linear-time HTML flattening ──────────────────────────────────────────────
// This runs on up to 500KB of HTML served by a stranger's server. The obvious
// implementation — `.replace(/<script[\s\S]*?<\/script>/gi, ' ')` and friends —
// is QUADRATIC on hostile input: a page that is just "<script " repeated with
// no closing tag makes the lazy `[\s\S]*?` scan to the end of the string once
// per opener. Measured at 500KB that is 40–65 seconds of CPU (a Worker gets
// 30s), reachable by ANY anonymous visitor who can host a page — the SSRF guard
// rightly passes it, because it is a normal public host. `<[^>]+>` has the
// same flaw on a long run of "<" with no ">".
//
// The scanners below do a bounded amount of work per character: every search
// uses a LITERAL pattern (no backtracking), always resumes from where the last
// one ended, and — the key point — the moment a closer is missing they stop,
// because if no closer exists after position p, none exists after any later
// opener either.

// First match of a literal (global, case-insensitive) regex at/after `from`.
function findLiteral(text, re, from) {
  re.lastIndex = from
  return re.exec(text)
}

// Removes every <open …> … <close> block, leaving a space in its place.
// `dropUnclosed`: what to do with an opener that never closes. Comments,
// <script> and <style> are raw-text states in HTML: a browser treats
// everything after an unclosed one as part of it, never as visible text, so
// the rest is dropped. Ordinary elements (<nav>, <footer>, …) are left in
// place, tags stripped later — matching what the old regex did.
function stripBlocks(text, openRe, closeRe, dropUnclosed) {
  let out = ''
  let pos = 0
  for (;;) {
    const open = findLiteral(text, openRe, pos)
    if (!open) { out += text.slice(pos); return out }
    const close = findLiteral(text, closeRe, open.index + open[0].length)
    if (!close) {
      out += dropUnclosed ? text.slice(pos, open.index) : text.slice(pos)
      return out
    }
    out += text.slice(pos, open.index) + ' '
    pos = close.index + close[0].length
  }
}

// Replaces every `<…>` tag with a space. A "<" with no later ">" cannot start
// a tag, so the remainder is kept verbatim and the scan ends.
function stripTags(text) {
  let out = ''
  let pos = 0
  for (;;) {
    const lt = text.indexOf('<', pos)
    if (lt === -1) return out + text.slice(pos)
    const gt = text.indexOf('>', lt + 1)
    if (gt === -1) return out + text.slice(pos)
    if (gt === lt + 1) {                 // "<>" is not a tag; keep it as text
      out += text.slice(pos, gt + 1)
      pos = gt + 1
      continue
    }
    out += text.slice(pos, lt) + ' '
    pos = gt + 1
  }
}

// Entities are decoded AFTER tags are stripped and BEFORE whitespace is
// collapsed, so "&nbsp;" becomes a real separator instead of surviving as the
// junk keyword "nbsp".
function htmlToText(html) {
  let t = html || ''
  t = stripBlocks(t, /<!--/g, /-->/g, true)
  t = stripBlocks(t, /<script(?=[\s/>])/gi, /<\/script\s*>/gi, true)
  t = stripBlocks(t, /<style(?=[\s/>])/gi, /<\/style\s*>/gi, true)
  for (const tag of ['nav', 'header', 'footer', 'aside'])
    t = stripBlocks(t, new RegExp(`<${tag}(?=[\\s/>])`, 'gi'), new RegExp(`<\\/${tag}\\s*>`, 'gi'), false)
  return decodeHtmlEntities(stripTags(t))
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Structured job data (schema.org JobPosting, JSON-LD) ─────────────────────
// FEATURE GAP CLOSED (Auth/Scan round): every <script> block was thrown away
// unread. But Google for Jobs REQUIRES a posting to publish its full
// description as a JSON-LD JobPosting, so nearly every real board (Greenhouse,
// Lever, Ashby, Workable, SmartRecruiters, and Workday's public pages) embeds
// the clean, complete job text there — including the client-rendered pages
// whose visible HTML is an empty shell and which this reader previously
// rejected as "unreadable" (Workday was even hard-coded as unsupported).
// Extraction is linear-time like the rest of this file: literal searches
// only, no lazy regexes over attacker-controlled input.
function extractJsonLdBlocks(html) {
  const out = []
  const MAX_BLOCK = 300_000
  let pos = 0
  const lower = html.toLowerCase()
  for (let guard = 0; guard < 200; guard++) {
    const open = lower.indexOf('<script', pos)
    if (open === -1) break
    const tagEnd = lower.indexOf('>', open)
    if (tagEnd === -1) break
    const close = lower.indexOf('</script', tagEnd)
    if (close === -1) break
    const openTag = lower.slice(open, Math.min(tagEnd, open + 300))
    if (/type\s*=\s*["']?application\/ld\+json/.test(openTag) && close - tagEnd <= MAX_BLOCK)
      out.push(html.slice(tagEnd + 1, close))
    pos = close + 8
  }
  return out
}

function collectJobPostings(node, found, depth = 0) {
  if (!node || depth > 6 || found.length > 5) return
  if (Array.isArray(node)) { for (const n of node) collectJobPostings(n, found, depth + 1); return }
  if (typeof node !== 'object') return
  const t = node['@type']
  if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) { found.push(node); return }
  if (node['@graph']) collectJobPostings(node['@graph'], found, depth + 1)
  if (node.itemListElement) collectJobPostings(node.itemListElement, found, depth + 1)
  if (node.item) collectJobPostings(node.item, found, depth + 1)
}

function fieldText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ')
  if (v && typeof v === 'object') return fieldText(v.name || v.description || v.value || '')
  return ''
}

// Returns the flattened posting text, or null when the page has no JobPosting
// — or has SEVERAL (a listing page, which must not be mistaken for one job).
function extractJobPostingText(html) {
  let postings = []
  for (const raw of extractJsonLdBlocks(html)) {
    let data
    try { data = JSON.parse(raw) } catch (_) { continue }
    collectJobPostings(data, postings)
  }
  // Same posting repeated across blocks is still one posting.
  const seen = new Set()
  postings = postings.filter(p => { const k = `${p.title}|${p.identifier?.value || p.url || ''}`; if (seen.has(k)) return false; seen.add(k); return true })
  if (postings.length !== 1) return null
  const p = postings[0]
  const desc = String(p.description || '').slice(0, 30_000)
  // Some boards double-escape the markup ("&lt;p&gt;").
  const body = htmlToText(/&lt;\/?[a-z]/i.test(desc) ? decodeHtmlEntities(desc) : desc)
  const parts = [
    fieldText(p.title),
    fieldText(p.hiringOrganization) && `Company: ${fieldText(p.hiringOrganization)}`,
    body,
    fieldText(p.responsibilities) && `Responsibilities: ${htmlToText(fieldText(p.responsibilities))}`,
    fieldText(p.qualifications) && `Qualifications: ${htmlToText(fieldText(p.qualifications))}`,
    fieldText(p.skills) && `Skills: ${htmlToText(fieldText(p.skills))}`,
    fieldText(p.experienceRequirements) && `Experience: ${htmlToText(fieldText(p.experienceRequirements))}`,
    fieldText(p.educationRequirements) && `Education: ${htmlToText(fieldText(p.educationRequirements))}`,
  ].filter(Boolean)
  const text = parts.join('\n').replace(/[ \t]+/g, ' ').trim()
  return text.length >= 200 ? text : null
}

async function fetchJobDescriptionFromUrl(url) {
  let parsed
  try { parsed = new URL(url) } catch (_) {
    return { success: false, blocked: false, text: null, message: 'Invalid URL.' }
  }
  if (isBlockedHost(parsed.hostname))
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

    if (fetched.blocked) {
      return { success: false, blocked: false, text: null, message: 'Could not read that page. Paste instead.' }
    }
    const res = fetched.res

    if (!res.ok) {
      return { success: false, blocked: false, text: null, message: 'Could not read that page. Paste instead.' }
    }

    // A PDF/image/zip that happens to be <500KB used to be UTF-8-decoded into
    // binary garbage that sailed past the length check and was scored as a JD.
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType && !/(text\/|html|xml|json)/.test(contentType)) {
      return { success: false, blocked: false, text: null,
        message: "That link doesn't look like a web page. Paste the job description instead." }
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
    // Structured data first: when the page declares exactly one JobPosting,
    // its text IS the job description (no nav, footer or "similar jobs").
    const structured = extractJobPostingText(html)
    if (structured) return { success: true, blocked: false, text: structured.slice(0, 5000) }

    let text = htmlToText(html)

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
    return { success: false, blocked: false, text: null,
      message: 'Could not read that page. Paste instead.' }
  } finally {
    // The 5s budget now covers the whole exchange INCLUDING the body read.
    // It used to be cleared as soon as headers arrived, so a server that
    // sent headers instantly and then dripped the body byte-by-byte could
    // hold the request open indefinitely.
    clearTimeout(timeout)
  }
}

module.exports = { fetchJobDescriptionFromUrl, isBlockedHost, htmlToText, looksLikeListingPage, extractJobPostingText }
