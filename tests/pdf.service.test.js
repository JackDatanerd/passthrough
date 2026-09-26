import { describe, it, expect, afterEach } from 'vitest'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'

// pdf.service.js talks to Cloudflare's Browser Rendering service through
// @cloudflare/puppeteer. Every other test that touches the scan/fix pipeline
// (scan.controller.test.js, docx.service.test.js) stubs generateResumePDF
// out completely — `generateResumePDF: async () => Buffer.from('fake-pdf')` —
// so none of them exercise this file's own logic. That logic is exactly the
// kind worth protecting: the JS-disable security hardening (a static resume
// has no legitimate need for JS, and this is a real Chromium session, so
// anything that slipped past sanitizeGeneratedHtml() would actually run),
// the timeout/net:: fallback retry, and the try/finally that guarantees
// page.close()/browser.close() run even when page.pdf() throws. This is
// that missing coverage (Section 12 audit).
//
// @cloudflare/puppeteer is stubbed the same way internal src/ deps are
// stubbed elsewhere in this suite (see loadWithStubs.cjs) — no real browser,
// no network, just a fake with the handful of methods pdf.service.js calls.
function fakePuppeteer(pdfBehavior) {
  const calls = []
  let pdfCallCount = 0
  const page = {
    setJavaScriptEnabled: async v => { calls.push(['setJavaScriptEnabled', v]) },
    setDefaultNavigationTimeout: async ms => { calls.push(['setDefaultNavigationTimeout', ms]) },
    setContent: async (html, opts) => { calls.push(['setContent', opts.waitUntil]) },
    emulateMediaType: async t => { calls.push(['emulateMediaType', t]) },
    pdf: async opts => {
      pdfCallCount++
      const outcome = pdfBehavior ? pdfBehavior(pdfCallCount) : Buffer.from(`pdf-${pdfCallCount}`)
      calls.push(['pdf', pdfCallCount, opts])
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    close: async () => { calls.push(['page.close']) },
  }
  const browser = {
    newPage: async () => { calls.push(['newPage']); return page },
    close: async () => { calls.push(['browser.close']) },
  }
  return { calls, launch: async env => { calls.push(['launch', env]); return browser } }
}

function setup(pdfBehavior) {
  const fake = fakePuppeteer(pdfBehavior)
  const { mod, restore } = loadWithStubs('services/pdf.service.js', {
    '@cloudflare/puppeteer': { launch: fake.launch },
  })
  return { mod, restore, calls: fake.calls }
}

let t
afterEach(() => t?.restore())

describe('pdf.service — generateResumePDF', () => {
  it('disables JS before content ever loads, renders for print, and returns the PDF bytes', async () => {
    t = setup()
    const env = { BROWSER: 'binding' }
    const buf = await t.mod.generateResumePDF(env, '<html>resume</html>')
    expect(buf.toString()).toBe('pdf-1')

    // Order matters: JS must be off before setContent ever runs the HTML.
    expect(t.calls.map(c => c[0])).toEqual([
      'launch', 'newPage', 'setJavaScriptEnabled', 'setDefaultNavigationTimeout',
      'setContent', 'emulateMediaType', 'pdf', 'page.close', 'browser.close',
    ])
    expect(t.calls.find(c => c[0] === 'launch')[1]).toBe(env.BROWSER)
    expect(t.calls.find(c => c[0] === 'setJavaScriptEnabled')[1]).toBe(false)
    expect(t.calls.find(c => c[0] === 'setContent')[1]).toBe('networkidle0')
    expect(t.calls.find(c => c[0] === 'pdf')[2]).toMatchObject({ format: 'A4', printBackground: true })
  })

  it('retries once with domcontentloaded when the first render times out, and still returns a PDF', async () => {
    t = setup(n => n === 1 ? new Error('Navigation timeout of 15000 ms exceeded') : Buffer.from(`pdf-${n}`))
    const buf = await t.mod.generateResumePDF({ BROWSER: {} }, '<html/>')
    expect(buf.toString()).toBe('pdf-2')
    expect(t.calls.filter(c => c[0] === 'setContent').map(c => c[1])).toEqual(['networkidle0', 'domcontentloaded'])
    expect(t.calls.filter(c => c[0] === 'pdf')).toHaveLength(2)
    // Cleanup still runs exactly once each, not once per attempt.
    expect(t.calls.filter(c => c[0] === 'page.close')).toHaveLength(1)
    expect(t.calls.filter(c => c[0] === 'browser.close')).toHaveLength(1)
  })

  it('retries on a net:: failure the same way it does on a timeout', async () => {
    t = setup(n => n === 1 ? new Error('net::ERR_ABORTED') : Buffer.from(`pdf-${n}`))
    const buf = await t.mod.generateResumePDF({ BROWSER: {} }, '<html/>')
    expect(buf.toString()).toBe('pdf-2')
    expect(t.calls.filter(c => c[0] === 'setContent').map(c => c[1])).toEqual(['networkidle0', 'domcontentloaded'])
  })

  it('does not retry a non-timeout, non-net:: error, and lets it propagate', async () => {
    t = setup(() => new Error('Some other rendering failure'))
    await expect(t.mod.generateResumePDF({ BROWSER: {} }, '<html/>')).rejects.toThrow('Some other rendering failure')
    expect(t.calls.filter(c => c[0] === 'pdf')).toHaveLength(1)
    expect(t.calls.filter(c => c[0] === 'setContent')).toHaveLength(1)
  })

  it('still closes the page and the browser when every attempt fails outright', async () => {
    t = setup(() => new Error('boom'))
    await expect(t.mod.generateResumePDF({ BROWSER: {} }, '<html/>')).rejects.toThrow('boom')
    expect(t.calls.filter(c => c[0] === 'page.close')).toHaveLength(1)
    expect(t.calls.filter(c => c[0] === 'browser.close')).toHaveLength(1)
  })

  it('still closes the page and the browser when the retried attempt also fails', async () => {
    t = setup(() => new Error('net::ERR_TIMED_OUT'))
    await expect(t.mod.generateResumePDF({ BROWSER: {} }, '<html/>')).rejects.toThrow('net::ERR_TIMED_OUT')
    expect(t.calls.filter(c => c[0] === 'pdf')).toHaveLength(2) // first attempt + retry, both fail
    expect(t.calls.filter(c => c[0] === 'page.close')).toHaveLength(1)
    expect(t.calls.filter(c => c[0] === 'browser.close')).toHaveLength(1)
  })
})
