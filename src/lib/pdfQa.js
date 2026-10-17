// Quality gate for the PDF we are about to DELIVER. The designed layout is model-written HTML; checkHtmlFidelity looks
// at that HTML, but what an applicant receives is what Chromium printed. This inspects the printed file with the same
// analyzer ingest uses on uploaded resumes (pdf.inspect.js), so we never ship a PDF our own scanner would flag.
//
// Rejects (reasons): more pages than the content can justify; a two-column layout; hidden text (tiny / off-page /
// white-on-white); the candidate's name or email missing from the extracted text (a font or encoding problem that
// leaves text unselectable or garbled for an ATS).
//
// It never BLOCKS on its own failure: if the inspector cannot read the bytes (or throws), the result is { ok: true,
// skipped: true } - a QA outage must not degrade or stop a paid delivery. The built-in template is the fallback the
// caller uses on a rejection, and the caller ships the template's PDF whatever this says.
const { analyzePdf } = require('../services/pdf.inspect')
const { estimateLoad } = require('./docFit')

const norm = s => String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// Pages a resume of this size can reasonably take: two for anything up to about two pages of content, then one more per
// ~44 line units. (A designed layout may set larger type than the template, so there is slack.)
const allowedPages = data => Math.max(2, Math.ceil(estimateLoad(data) / 44))

async function checkRenderedPdf(bytes, data) {
  let r
  try { r = await analyzePdf(bytes) } catch (_) { return { ok: true, skipped: true, reasons: [] } }
  if (!r) return { ok: true, skipped: true, reasons: [] }
  if (r.failure) {
    if (r.failure.code === 'TOO_MANY_PAGES') return { ok: false, reasons: [`${r.failure.pages} pages`], pages: r.failure.pages }
    return { ok: true, skipped: true, reasons: [] }
  }
  const reasons = []
  const pages = r.structure?.pages || 0
  const max = allowedPages(data)
  if (pages > max) reasons.push(`${pages} pages for content that needs at most ${max}`)
  if ((r.structure?.columns || 1) > 1) reasons.push('multi-column layout')
  if ((r.structure?.hiddenTextChars || 0) > 0) reasons.push('hidden text')
  const text = norm(r.text)
  const name = norm(data?.name), email = norm(data?.email)
  if (name && !text.includes(name)) reasons.push('name missing from the PDF text')
  if (email && !text.includes(email)) reasons.push('email missing from the PDF text')
  return { ok: reasons.length === 0, reasons, pages }
}

module.exports = { checkRenderedPdf, allowedPages }
