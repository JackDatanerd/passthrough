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
// NOTE: Browser Rendering is metered per-second of browser usage and caps how many browsers may
// run (and be started per minute) at once. Two guards keep a burst from turning into failed paid
// jobs: the fix-queue consumer's `max_concurrency` (wrangler.toml) bounds how many renders run in
// parallel, and launchBrowser() below retries a launch the service refused for being over its limit
// instead of failing the render. The pre-launch load test is in DEPLOYMENT.md ("Pre-launch
// verification") — run it before assuming this scales.

const puppeteer = require('@cloudflare/puppeteer')

// A launch refused because the account is over its concurrent-browser or launches-per-minute limit
// is transient by nature: the limit frees as other sessions close. Retrying a few times with a
// growing pause turns "the burst hit the cap" into a short delay rather than a failed render (the
// caller degrades a failed PDF to DOCX-only, so an unretried refusal quietly shipped a worse product).
// Any other launch error is NOT retried — it would fail the same way.
const LAUNCH_RETRY_DELAYS_MS = [2000, 5000, 10000]
const isLaunchLimitError = err => /\b429\b|rate limit|too many|limit exceeded|concurrent|capacity/i.test(String((err && err.message) || err))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function launchBrowser(env, delays = LAUNCH_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await puppeteer.launch(env.BROWSER)
    } catch (err) {
      if (attempt >= delays.length || !isLaunchLimitError(err)) throw err
      console.error(`Browser Rendering launch refused (${err.message}) — retry ${attempt + 1}/${delays.length}`)
      await sleep(delays[attempt])
    }
  }
}

async function generateResumePDF(env, html, { launchRetryDelaysMs } = {}) {
  const browser = await launchBrowser(env, launchRetryDelaysMs)
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
      // BUG FIX (Scan/ATS pass): the fallback below only wrapped page.pdf(),
      // but the failure it exists for — the render template pulling Google
      // Fonts, so `networkidle0` never settles — is thrown by
      // page.setContent(), which sat OUTSIDE the try. A slow or blocked font
      // request therefore escaped straight past the fallback and failed the
      // whole PDF (the test stub's setContent never throws, which is why
      // this went unnoticed). The load AND the print now live in one
      // attempt, so a timeout / net:: error at either step retries once with
      // `domcontentloaded`, which doesn't wait on the network at all.
      const render = async waitUntil => {
        await page.setContent(html, { waitUntil })
        await page.emulateMediaType('print')
        return page.pdf({
          format: 'A4', printBackground: true,
          // Vertical margins are real page margins so every page of a multi-page resume has them;
          // the layouts (pdfTemplate.service.js, the AI prompt) declare the same @page margin.
          margin: { top: '14mm', right: '0', bottom: '14mm', left: '0' }
        })
      }
      try {
        return await render('networkidle0')
      } catch (err) {
        const msg = String((err && err.message) || '')
        if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('net::')) {
          return await render('domcontentloaded')
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

module.exports = { generateResumePDF, isLaunchLimitError }
