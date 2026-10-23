// One definition of "this contact detail is a link", shared by the DOCX and the PDF renderers so the two files an
// applicant sends out can never disagree about what is clickable.
//
// Only http(s), mailto and tel targets are ever produced; anything else stays plain text. The old DOCX rule matched a
// fixed list of 13 top-level domains, so a portfolio on .design / .tech / .ng / .co.za / .in / .ca / .edu / .studio, or a
// linktr.ee/… link, silently came out as grey text. A bare host is now recognised structurally (dotted labels, an
// alphabetic TLD of 2-24 letters, optional port and path) instead of by a vocabulary.

const EMAIL  = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,24}$/
const SCHEME = /^https?:\/\/[^\s<>"']+$/i
const BARE   = /^(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#][^\s<>"']*)?$/i

/**
 * hrefFor(text, { phone }) -> a safe href string, or null when the text is not plainly a link.
 * `phone: true` also turns a phone number into a tel: link (contact lines only — a project "link" is never a phone).
 */
function hrefFor(text, { phone = false } = {}) {
  const t = String(text == null ? '' : text).trim()
  if (!t || t.length > 300 || /\s/.test(t) && !(phone && /^[\s(]*\+?[\d\s().-]+$/.test(t))) return null
  if (EMAIL.test(t)) return `mailto:${t}`
  if (SCHEME.test(t)) return t
  if (BARE.test(t)) return `https://${t}`
  // "+44 7700 900123", "(+44) 7700 900123", "+1 (415) 555-0100": the plus counts wherever it stands before the first digit
  // (it used to be required at the very start, so "(+44) ..." was not linked at all).
  if (phone && /^[\s(]*\+?[\s(]*\d[\d\s().-]{5,23}$/.test(t)) {
    const digits = t.replace(/\D/g, '')
    if (digits.length >= 7 && digits.length <= 15) return `tel:${/^[\s(]*\+/.test(t) ? '+' : ''}${digits}`
  }
  return null
}

// What a person reads for a URL: no scheme, no trailing slash. "https://passthrough.app/verify/AB12/" -> "passthrough.app/verify/AB12".
function displayUrl(url) {
  return String(url || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

module.exports = { hrefFor, displayUrl }
