// A bullet's text, without a bullet glyph of its own. The renderers draw the bullet (a literal "•" in the DOCX, a list
// marker in the PDF), so a line that arrives already carrying one - pasted into the editor from a Word or LinkedIn list,
// or echoed by the model from the original - came out as "• • Built…" (or "• - Built…") in the delivered file.
//
// One leading marker is removed, never digits ("5% growth", "2019 – 2021 …") and never a hyphen glued to a word
// ("-based", "–5% churn"): a dash, star or middle dot counts as a marker only when whitespace follows it; the real bullet
// glyphs also count when the text follows directly ("•Built").
const GLYPH = /^\s*(?:[•●▪■◦‣▸►○◆◇▶➢➤✓✔]\s*|[-–—*·∙]\s+)+/

function stripBullet(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text))
  const out = s.replace(GLYPH, '')
  return out.trim() ? out : s          // a line that is ONLY a marker is left as it was
}

module.exports = { stripBullet }
