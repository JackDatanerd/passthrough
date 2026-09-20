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

  const apiUrl = env.API_URL
  if (!apiUrl || !code) return response

  let data = null
  try {
    const apiRes = await fetch(`${apiUrl}/verify/${encodeURIComponent(code)}`)
    if (apiRes.ok) {
      const json = await apiRes.json()
      if (json.success) data = json.data
    }
  } catch (_) {
    // API unreachable or slow — fall through to the default static page
    // rather than block/break the response for a real visitor.
  }

  if (!data) return response

  const scoreLine = typeof data.atsScore === 'number' ? ` — ATS score ${data.atsScore}/100` : ''
  const namePrefix = data.candidateFirstName ? `${data.candidateFirstName}: ` : ''
  const title = data.passed
    ? `${namePrefix}Passthrough Verified${scoreLine}`
    : `${namePrefix}Passthrough Scan Report${scoreLine}`
  const description = data.passed
    ? `Cryptographically verified by Passthrough — this resume has not been modified since it was scanned and scored${scoreLine}.`
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
      }
    }
  }

  class TitleRewriter {
    element(el) {
      el.setInnerContent(title)
    }
  }

  return new HTMLRewriter()
    .on('meta', new MetaRewriter())
    .on('title', new TitleRewriter())
    .transform(response)
}
