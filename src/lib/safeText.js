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

module.exports = { stripLoneSurrogates, safeSlice }
