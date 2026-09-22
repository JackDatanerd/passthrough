// Cloudflare Pages Function — /v/:code
//
// FEATURE GAP FIX: this SPA previously served one static index.html with
// hardcoded, site-wide Open Graph / Twitter Card meta tags for every route,
// including /v/:code — the one page whose entire purpose is to be shared
// (a candidate posting their badge on LinkedIn, a hiring manager forwarding
// a link). A link-preview crawler (LinkedIn, Twitter/X, Slack, iMessage,
// etc.) never executes JavaScript — it only reads the raw HTML it's given —
// so every share of a verification link unfurled as the generic homepage
// ("Does your resume pass the ATS filter?") instead of anything about the
// actual candidate or score.
//
// This intercepts requests to /v/:code, fetches the same public data
// verify.controller.js's getVerification already serves, and rewrites just
// the <meta> tags of the underlying static index.html before it's returned.
// HTMLRewriter only touches meta tags — the React app's markup and boot
// script are untouched, so real visitors get exactly the same SPA as
// before; this only changes what a crawler sees when it fetches the page
// without running JS.
//
// Requires an API_URL environment variable configured on the Cloudflare
// Pages project (same value as VITE_API_URL, but read server-side at
// request time — VITE_API_URL is baked into the client bundle at build
// time and isn't available here). See DEPLOYMENT.md section 6.
//
// Fails open on any problem (missing env var, unreachable API, unknown
// code) by returning the untouched static response — a slow/broken API
// call must never take the page itself down.

export async function onRequestGet(context) {
  const { params, env, request } = context
  const code = params.code

  // Always resolve the real static response first (this is the built
  // index.html, via the project's /* -> /index.html SPA fallback) — every
  // fix here is a rewrite of that response, never a hand-built substitute,
  // so the SPA's own boot behavior can't drift from what real users get.
  const response = await context.next()

  if (!env.API_URL || !code) return response
  // Every Worker route lives under /api. DEPLOYMENT.md used to say to set
  // API_URL to the bare host, which made this fetch hit /verify/<code> (404)
  // and silently fail open — so link previews never worked. Accept either form.
  const noTrailing = String(env.API_URL).trim().replace(/\/+$/, '')
  const apiUrl = /\/api$/i.test(noTrailing) ? noTrailing : `${noTrailing}/api`

  let data = null
  try {
    // SECTION 7 AUDIT (bug B7-3): this fetch used to hit the same endpoint a
    // real visitor's browser calls — every crawler request (and there can be
    // several per share, one per platform) counted as a view, and paid for a
    // full R2 read + SHA-256 re-hash for an integrity check nothing here even
    // reads. `preview=1` tells the API to skip both. A hard timeout is also
    // new: the header comment above says a slow API "must never take the
    // page itself down", but nothing previously enforced that — an API that
    // hangs (rather than erroring) would have held this Function, and the
    // visitor's page load, open indefinitely.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const apiRes = await fetch(`${apiUrl}/verify/${encodeURIComponent(code)}?preview=1`, { signal: controller.signal })
    clearTimeout(timeout)
    if (apiRes.ok) {
      const json = await apiRes.json()
      if (json.success) data = json.data
    }
  } catch (_) {
    // API unreachable, slow (timed out above), or errored — fall through to
    // the default static page rather than block/break the response for a
    // real visitor.
  }

  if (!data) return response
  if (data.code === 'REVOKED' || data.success === false) return response

  // SECTION 7 AUDIT (bug B7-1): `preview=1` responses never claim `verified`
  // either way (see verify.controller.js) — this only ever describes the
  // scan-report/verified DISTINCTION for the unfurl copy, never asserts a
  // "cryptographically verified" claim a crawler can't itself check, so it's
  // safe to key off the score-only `data.passed` here.
  const scoreLine = typeof data.atsScore === 'number' ? ` — ATS score ${data.atsScore}/100` : ''
  const namePrefix = data.candidateFirstName ? `${data.candidateFirstName}: ` : ''
  const title = data.passed
    ? `${namePrefix}Passthrough Verified${scoreLine}`
    : `${namePrefix}Passthrough Scan Report${scoreLine}`
  const description = data.passed
    ? `Scanned and scored by Passthrough's ATS engine${scoreLine}. Open the link to see the live, cryptographically-verified status.`
    : `Scanned by Passthrough's ATS engine${scoreLine}. Below the Passthrough Verified threshold.`
  const pageUrl = request.url

  class MetaRewriter {
    element(el) {
      const key = el.getAttribute('property') || el.getAttribute('name')
      if (key === 'og:title' || key === 'twitter:title') {
        el.setAttribute('content', title)
      } else if (key === 'og:description' || key === 'twitter:description') {
        el.setAttribute('content', description)
      } else if (key === 'og:url') {
        el.setAttribute('content', pageUrl)
      } else if (key === 'robots') {
        el.setAttribute('content', 'noindex, nofollow')
      }
    }
  }

  class TitleRewriter {
    element(el) {
      el.setInnerContent(title)
    }
  }

  // SECTION 7 AUDIT (feature gap G7-5): a candidate's verification page has no
  // business showing up in Google — it identifies them by first name next to
  // a numeric score. A noindex META tag (not a robots.txt Disallow) is used
  // deliberately: robots.txt would also block the link-preview crawlers this
  // whole file exists to serve (LinkedIn, Slack, iMessage, etc. don't obey
  // noindex, but some respect a disallowed path and skip the fetch entirely),
  // while a plain <meta name="robots"> only tells indexers like Google not to
  // list the page — unfurling still works exactly as above.
  class HeadRewriter {
    element(el) {
      el.append('<meta name="robots" content="noindex, nofollow">', { html: true })
    }
  }

  return new HTMLRewriter()
    .on('meta', new MetaRewriter())
    .on('title', new TitleRewriter())
    .on('head', new HeadRewriter())
    .transform(response)
}
