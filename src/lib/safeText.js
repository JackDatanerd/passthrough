// Text cut by UTF-16 length can be cut in the middle of an emoji (or any character outside the BMP), which leaves half of
// a surrogate pair. Postgres refuses that in a text/jsonb value ("invalid input syntax for type json"), so a job posting
// that happened to carry an emoji at its cap boundary made the whole insert fail - and the Anthropic API takes the same
// view of a lone surrogate in a prompt. Scan/ATS round 10.
//
// stripLoneSurrogates: removes any surrogate half that has lost its partner (the same rule profile.controller uses for
//   labels). safeSlice: str.slice(0, n) that never leaves a trailing high surrogate behind.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
const TRAILING_HIGH  = /[\uD800-\uDBFF]$/

function stripLoneSurrogates(s) {
  return typeof s === 'string' ? s.replace(LONE_SURROGATE, '') : s
}

function safeSlice(s, n) {
  const cut = String(s ?? '').slice(0, n)
  return TRAILING_HIGH.test(cut) ? cut.slice(0, -1) : cut
}

// Scan/ATS round 12: text that comes from OUTSIDE (a document's numeric character references, a PDF's text layer, the
// OCR fallback, a fetched web page or its JSON-LD) is cleaned here before it is scored, sent to the model or stored.
// A form field is cleaned at the door (middleware/upload.js); these sources never passed through that door, and a NUL
// or a lone surrogate half in them made the report / job-description write fail (22P05 / 22P02) - the scan ended as a
// "temporary problem" that every retry reproduced.
//   cleanText: NUL removed, lone surrogate halves removed. Non-strings pass through.
//   cleanDeep: the same for every string (and key) inside an object / array, for values about to be written as jsonb.
function cleanText(s) {
  return typeof s === 'string' ? stripLoneSurrogates(s.includes('\u0000') ? s.replace(/\u0000/g, '') : s) : s
}
function cleanDeep(v) {
  if (typeof v === 'string') return cleanText(v)
  if (Array.isArray(v)) return v.map(cleanDeep)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) Object.defineProperty(out, cleanText(k), { value: cleanDeep(val), writable: true, enumerable: true, configurable: true })
    return out
  }
  return v
}

module.exports = { stripLoneSurrogates, safeSlice, cleanText, cleanDeep }
