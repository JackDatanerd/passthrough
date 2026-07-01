// Replaces the disk-based version. R2 has no filesystem — callers fetch the
// object body as an ArrayBuffer (env.RESUMES_BUCKET.get(key) -> .arrayBuffer())
// and pass the raw bytes here instead of a path. pdf-parse already accepted a
// Buffer directly in v8 (fs.readFileSync returns one) — only mammoth's call
// signature changes, from { path } to { buffer }. `Buffer` is available globally
// thanks to the `nodejs_compat` compatibility flag in wrangler.toml.
//
// lib path import unchanged — avoids the same pdf-parse ENOENT test-file bug.
const pdfParse = require('pdf-parse/lib/pdf-parse')
const mammoth   = require('mammoth')
const c         = require('../config/constants')

// Used by runAtsScan — no Claude, no cost on free scans
async function extractText(bytes, mimeType) {
  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (mimeType === 'application/pdf') {
      const data = await pdfParse(buffer)
      return data.text || ''
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
