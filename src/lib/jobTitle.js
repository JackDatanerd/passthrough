// A short human label for a scan, taken from the pasted job description, so the
// dashboard can tell ten rescans of the same resume apart. Heuristic and
// best-effort by design: a JD has no reliable structure, so this looks at the
// first few lines for something shaped like a title and returns null (the
// dashboard then falls back to the role category) rather than guess badly.
//
// The SQL backfill in migration 0035 applies the same rule to old scans (first
// line only, same boilerplate filter) — keep the two in step.

// Lines that introduce a section or a company blurb rather than name the role.
const BOILERPLATE = /^(about|job\s*(description|summary|details|overview)|description|overview|company|who we are|we are|we're|we’re|our (mission|team|company)|location|responsibilit|apply|position summary)/i
const LABEL_PREFIX = /^(job\s*title|position|role|title)\s*[:\-–—]\s*/i
const MAX_LINES_SCANNED = 12
const MAX_TITLE_LENGTH = 100
const MIN_TITLE_LENGTH = 3

function deriveJobTitle(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, MAX_LINES_SCANNED)
  for (const raw of lines) {
    let line = raw
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b\u2060\ufeff\u2028\u2029]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(LABEL_PREFIX, '')
      .replace(/^[#*\-•·\s]+/, '')
      .replace(/[*#\s]+$/, '')
      .trim()
    if (line.length < MIN_TITLE_LENGTH || line.length > MAX_TITLE_LENGTH) continue
    if (BOILERPLATE.test(line)) continue
    // A full sentence ("We are looking for a motivated…") is a blurb, not a title.
    if (/[.!?]$/.test(line) && line.split(' ').length > 8) continue
    return line
  }
  return null
}

module.exports = { deriveJobTitle, MAX_TITLE_LENGTH }
