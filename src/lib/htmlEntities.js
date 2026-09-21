// Minimal, dependency-free HTML entity decoder.
//
// Why this exists: jd.parser.js flattens a fetched job page to text with
// regexes (no DOM on Workers), and nothing ever decoded entities afterward.
// A page containing "Kubernetes&nbsp;Docker" or "R&amp;D" therefore reached
// keyword extraction as-is, where "nbsp" / "amp" / "quot" became "missing
// keywords" that the user was told their resume lacked. The same thing
// happens to a JD pasted from an HTML source. ats.service.js also calls
// this defensively, so both entry paths are covered.
//
// Only decodes what carries meaning in JD text. Any other well-formed
// entity ("&foo;") is replaced with a space rather than left behind as a
// junk token.

const NAMED = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', shy: '',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lsquo: "'", rsquo: "'", sbquo: "'", ldquo: '"', rdquo: '"', bdquo: '"',
  ndash: '-', mdash: '-', minus: '-', hellip: '...', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  euro: '€', pound: '£', yen: '¥', cent: '¢', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç',
}

function safeFromCodePoint(n) {
  // Reject NUL, surrogates and out-of-range values rather than throwing.
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' '
  const ch = String.fromCodePoint(n)
  return ch === '\u00a0' ? ' ' : ch
}

function decodeHtmlEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input
  return input.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return safeFromCodePoint(n)
    }
    const key = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : ' '
  })
}

module.exports = { decodeHtmlEntities }
