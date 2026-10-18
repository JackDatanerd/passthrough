// Typographic ligature code points (U+FB00-FB06: ff fi fl ffi ffl long-s-t st) back to the letters they stand for.
// PDF text extraction hands these through verbatim for any resume set in a font with ligature glyphs (LaTeX does this by default), so
// a resume that says "finance" arrives as "ﬁnance" and an ATS keyword match on "finance" silently fails - in OUR scan of the upload and, if
// it is carried into the delivered file, in the employer's. Only these seven characters are touched (NFKC would also rewrite
// superscripts, trademark signs and full-width forms, which are content).
const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' }
const unligature = v => (typeof v === 'string' ? v.replace(/[\uFB00-\uFB06]/g, c => LIGATURES[c]) : v)
module.exports = { unligature }
