// Which palette headings are set in a serif. One definition for the PDF template (Georgia stack) and the Word files (Georgia
// heading style), so the two documents of a set carry the same type.
const isSerifHeading = name => /Merriweather|Playfair|Baskerville|Cormorant|Crimson/i.test(String(name || ''))
module.exports = { isSerifHeading }
