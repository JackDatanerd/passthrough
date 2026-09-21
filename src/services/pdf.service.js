// THE VPS-REMOVING CHANGE. v8 required a VPS for exactly one reason: local
// Puppeteer needs a real Chromium binary, which Workers can't run in-isolate.
// @cloudflare/puppeteer talks to Cloudflare's managed Browser Rendering
// service instead — same Puppeteer API surface, no local browser process.
//
// Key differences from the v8 version:
//   - puppeteer.launch(env.BROWSER) instead of puppeteer.launch({ args: [...] })
//     — there's no local Chromium to configure sandbox flags for.
//   - No persistent browser singleton / process.on('exit') handlers. Workers
//     isolates are short-lived and can be recycled between requests, so a
//     module-level singleton would risk operating on a dead session. Each
//     call launches and closes its own browser — slightly more overhead per
//     call, but correct under the Workers execution model.
//   - Returns the PDF as bytes (Uint8Array) instead of writing to a path —
//     the caller .put()s those bytes into R2. No local filesystem exists.
//
// NOTE (flagged, unverified at scale): Browser Rendering is metered
// per-second of browser usage. This implementation is correct but has not
// been load-tested under concurrent traffic — see deployment guide's
// pre-launch verification checklist before assuming this scales for free.

const puppeteer = require('@cloudflare/puppeteer')

async function generateResumePDF(env, html) {
  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    try {
      // The HTML rendered here is AI-generated from user-supplied resume
      // content (see claude.service.js's generateBeautifulResumeHTML), which
      // already runs it through sanitizeGeneratedHtml() before it gets here —
      // that strips event-handler attributes, javascript:/data: URIs, and
      // resource-loading tags/CSS, not just <script> tags. Belt-and-suspenders
      // regardless: since this is a real Chromium session (Cloudflare Browser
      // Rendering), anything that slipped past that sanitizer would actually
      // execute. A static resume layout has no legitimate need for JS, so
      // disabling it outright closes the whole class of issue rather than
      // relying solely on the upstream regex-based sanitizer.
      await page.setJavaScriptEnabled(false)
      await page.setDefaultNavigationTimeout(15000)
      await page.setContent(html, { waitUntil: 'networkidle0' })
      await page.emulateMediaType('print')
      try {
        const buf = await page.pdf({
          format: 'A4', printBackground: true,
          margin: { top: '0', right: '0', bottom: '0', left: '0' }
        })
        return buf
      } catch (err) {
        if (err.message.includes('timeout') || err.message.includes('net::')) {
          await page.setContent(html, { waitUntil: 'domcontentloaded' })
          const buf = await page.pdf({
            format: 'A4', printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
          })
          return buf
        }
        throw err
      }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

module.exports = { generateResumePDF }
