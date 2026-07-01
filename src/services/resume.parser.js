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
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (mimeType === 'application/pdf') {
      const { extractText: pdfExtract } = await import('unpdf')
      // unpdf expects a Uint8Array
      const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      const { text } = await pdfExtract(uint8)
      return text || ''
    }
    const r = await mammoth.extractRawText({ buffer })
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
      parseErrorMessage: 'Could not extract resume structure.'
    }
  return { text: truncated, resumeData: result.data, parseError: false }
}

module.exports = { extractText, parse }
