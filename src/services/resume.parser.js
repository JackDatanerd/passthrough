// pdf-parse uses String.fromCharCode.apply(null, largeTypedArray) internally,
// which overflows the Cloudflare Workers call stack for any non-trivial PDF.
// Replaced with `unpdf`, which uses pdfjs-dist's edge-compatible build and
// is specifically designed for Worker/edge runtimes.
//
// .docx extraction uses jszip + native Promises directly (see extractDocxText
// below) rather than mammoth — see that function's comment for why.
//
// unpdf is ESM-only, so it's loaded via dynamic import() — esbuild (wrangler's
// bundler) handles the CJS/ESM mix at bundle time without any issues.

const JSZip   = require('jszip')
const c        = require('../config/constants')

// HARDENING: the 5MB upload cap (middleware/upload.js) only bounds the
// COMPRESSED size on the wire — it says nothing about how large the
// decompressed word/document.xml can get. A crafted .docx with pathological
// compression can expand far past its on-disk size once JSZip inflates it,
// which then gets fed into the paragraph-matching regexes below. This isn't
// a full zip-bomb defense (JSZip has already done the decompression work by
// the time this check runs), but it stops a merely-oversized result from
// being handed to the regex engine and from bloating the ~8000-char resume
// text pipeline downstream. A legitimate resume's document.xml is reliably
// well under 1MB; 20MB gives generous headroom for an unusually long/complex
// real resume while still rejecting anything wildly out of proportion to a
// 5MB input.
const MAX_DOCX_XML_CHARS = 20 * 1024 * 1024

// Direct .docx text extraction via JSZip + native Promises, bypassing
// mammoth's extractRawText entirely for this specific call.
//
// Context: mammoth's extractRawText was consistently throwing "Could not
// find file in options" in production — but a live diagnostic log
// (console.log of typeof/constructor/length right before the call)
// confirmed the input was a genuine, correctly-shaped, non-empty
// Uint8Array every single time. A local Node reproduction with the same
// mammoth version confirmed that error can ONLY happen when mammoth's
// `buffer` option is truly undefined — never for a valid Uint8Array. Since
// the input was proven valid but the failure was 100% reproducible in
// production and 0% reproducible locally, the remaining difference is the
// execution environment itself: mammoth uses `bluebird` (a full third-party
// Promise library with its own internal object pooling for performance)
// instead of native Promises for all of its internal async plumbing, and
// bluebird was never built with Cloudflare Workers' isolate-reuse-across-
// requests execution model in mind — unlike a fresh Node process per
// request, a Workers isolate can retain module-level state across many
// requests, which is exactly the kind of thing a pooling-optimized promise
// library can behave unpredictably under.
//
// Rather than keep debugging a third-party library's internal scheduling
// inside an environment it wasn't designed for, this extracts only what's
// actually needed (plain text from the document body) directly via jszip
// (which mammoth itself depends on, so this doesn't add a new dependency)
// and native Promises throughout. This intentionally doesn't replicate
// every OOXML edge case mammoth's full HTML conversion handles (tables,
// headers/footers, text boxes) — it targets standard resume body text,
// which is what actually needs to reach the ATS scorer and Claude.
async function extractDocxText(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  const docXml = zip.file('word/document.xml')
  if (!docXml) throw new Error('word/document.xml not found — not a valid .docx file')
  const xml = await docXml.async('string')

  // HARDENING: reject before regex-parsing — see MAX_DOCX_XML_CHARS comment
  // above for why this check exists and why the limit is set where it is.
  if (xml.length > MAX_DOCX_XML_CHARS)
    throw new Error('Document content too large after decompression — not a valid resume file')

  const paragraphs = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []
  const lines = paragraphs.map(p => {
    // Convert tabs/line-breaks within a paragraph before stripping tags, so
    // cell/line structure isn't just silently collapsed into one run. These
    // get matched alongside <w:t> content below (not separately extracted
    // afterward) since a separate extraction pass would only look inside
    // <w:t>...</w:t> tags and silently drop any inserted \t/\n sitting
    // outside them.
    const withBreaks = p.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
    const parts = []
    for (const m of withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|[\t\n]/g)) {
      parts.push(m[1] !== undefined ? m[1] : m[0])
    }
    return parts.join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  })
  return lines.filter(Boolean).join('\n')
}

async function extractText(bytes, mimeType) {
  try {
    if (mimeType === 'application/pdf') {
      const { extractText: pdfExtract } = await import('unpdf')
      // mergePages: true is required — without it, unpdf returns `text` as an
      // array of per-page strings (string[]) instead of one merged string,
      // which crashes every caller that does rawResumeText.trim() downstream.
      const { text } = await pdfExtract(bytes, { mergePages: true })
      return text || ''
    }
    return await extractDocxText(bytes)
  } catch (err) {
    console.error('extractText:', err.message)
    return ''
  }
}

// Used by generateFix/generateBadge only — calls Claude
async function parse(env, bytes, mimeType) {
  const text = await extractText(bytes, mimeType)
  if (!text || text.trim().length < 100)
    return {
      text: '',
      resumeData: null,
      parseError: true,
      parseErrorMessage: 'Resume could not be parsed. Upload a text-based PDF or .docx.'
    }
  const truncated = text.slice(0, c.MAX_RESUME_CHARS)
  const claude    = require('./claude.service')
  const result    = await claude.parseResumeStructure(env, truncated)
  if (!result.success)
    return {
      text: truncated,
      resumeData: null,
      parseError: true,
      // Preserve the real reason (RESPONSE_TRUNCATED / PARSE_FAIL / an
      // Anthropic API error message) instead of masking it with a generic
      // string — this is what showed up as "Could not extract resume
      // structure" with no further detail in production logs.
      parseErrorMessage: `Could not extract resume structure (${result.error || 'unknown'}).`
    }
  return { text: truncated, resumeData: result.data, parseError: false }
}

// Brain-dump entry path (Phase 1) equivalent of parse() above. There's no
// file to extract text from — the raw text IS the input — so this skips
// straight to structuring via claude.service's structureFreeformText.
// Same return shape as parse() so runAtsScan/generateFix/generateBadge can
// treat both entry paths identically after this point.
async function structureBrainDump(env, rawText) {
  if (!rawText || rawText.trim().length < 100)
    return {
      text: '',
      resumeData: null,
      parseError: true,
      parseErrorMessage: 'Tell us a bit more about your background — at least a few sentences.'
    }
  const truncated = rawText.slice(0, c.MAX_RESUME_CHARS)
  const claude = require('./claude.service')
  const result = await claude.structureFreeformText(env, truncated)
  if (!result.success)
    return {
      text: truncated,
      resumeData: null,
      parseError: true,
      parseErrorMessage: `Could not structure your background (${result.error || 'unknown'}). Try adding more detail — company names, roles, and what you did.`
    }
  return { text: truncated, resumeData: result.data, parseError: false }
}

// Deterministic — no AI. Renders a structured resumeData object back into
// plain text so the same rule-based ATS scoring engine (ats.service.js) can
// run against brain-dump input exactly as it does against extracted file
// text. This is a formatting step only: it exists because scoreResume()
// expects a plain-text resume with recognizable section headers and bullet
// markers, and raw freeform brain-dump text won't reliably have either.
// Deterministic on purpose — scoring must be reproducible from the same
// structured data every time, with no AI variance in between structuring
// and scoring.
function serializeResumeData(resumeData) {
  const lines = []
  if (resumeData.name) lines.push(resumeData.name)
  const contactParts = [resumeData.email, resumeData.phone, resumeData.location].filter(Boolean)
  if (contactParts.length) lines.push(contactParts.join(' | '))
  lines.push('')

  if (resumeData.summary) {
    lines.push('SUMMARY')
    lines.push(resumeData.summary)
    lines.push('')
  }

  if (resumeData.experience?.length) {
    lines.push('EXPERIENCE')
    for (const job of resumeData.experience) {
      const header = [job.title, job.company, job.dates].filter(Boolean).join(' — ')
      if (header) lines.push(header)
      for (const bullet of (job.bullets || [])) lines.push(`- ${bullet}`)
    }
    lines.push('')
  }

  if (resumeData.education?.length) {
    lines.push('EDUCATION')
    for (const edu of resumeData.education) {
      const header = [edu.degree, edu.institution, edu.dates].filter(Boolean).join(' — ')
      if (header) lines.push(header)
    }
    lines.push('')
  }

  if (resumeData.skills?.length) {
    lines.push('SKILLS')
    lines.push(resumeData.skills.join(', '))
    lines.push('')
  }

  if (resumeData.certifications?.length) {
    lines.push('CERTIFICATIONS')
    for (const cert of resumeData.certifications) lines.push(`- ${cert}`)
  }

  return lines.join('\n')
}

module.exports = { extractText, parse, structureBrainDump, serializeResumeData }
