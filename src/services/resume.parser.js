// pdf-parse uses String.fromCharCode.apply(null, largeTypedArray) internally,
// which overflows the Cloudflare Workers call stack for any non-trivial PDF.
// Replaced with `unpdf`, which uses pdfjs-dist's edge-compatible build and
// is specifically designed for Worker/edge runtimes. mammoth is unchanged.
//
// unpdf is ESM-only, so it's loaded via dynamic import() — esbuild (wrangler's
// bundler) handles the CJS/ESM mix at bundle time without any issues.

const mammoth = require('mammoth')
const c        = require('../config/constants')

async function extractText(bytes, mimeType) {
  try {
    // No Buffer conversion — pass the Uint8Array straight through to both
    // libraries. Previously this went through
    // `Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)` first, but
    // Buffer.from() under the Workers nodejs_compat polyfill was
    // intermittently producing `undefined` here (confirmed by local
    // reproduction: mammoth's "Could not find file in options" error is
    // ONLY produced when its `buffer` option is literally undefined — a
    // real or empty Buffer/Uint8Array produces a different error entirely).
    // Both unpdf (expects Uint8Array) and mammoth's JSZip-based zip reader
    // (accepts Uint8Array/ArrayBuffer/Buffer interchangeably) work fine
    // with the raw bytes directly, so this removes an unnecessary and
    // apparently-unreliable dependency on the Buffer polyfill.
    if (mimeType === 'application/pdf') {
      const { extractText: pdfExtract } = await import('unpdf')
      // mergePages: true is required — without it, unpdf returns `text` as an
      // array of per-page strings (string[]) instead of one merged string,
      // which crashes every caller that does rawResumeText.trim() downstream.
      const { text } = await pdfExtract(bytes, { mergePages: true })
      return text || ''
    }
    const r = await mammoth.extractRawText({ buffer: bytes })
    return r.value || ''
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
