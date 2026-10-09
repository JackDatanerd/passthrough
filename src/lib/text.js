// Shared cleaning for short human-entered text that ends up in emails, page
// headings and documents. Kept deliberately conservative: it removes what can
// only ever be an accident or an attack (control characters, invisible
// filler) and leaves everything a real name can contain — including the
// zero-width joiners / non-joiners and directional marks that Persian, Indic
// and Arabic-script names genuinely need.
const { z } = require('zod')

// C0 / C1 control characters (incl. tab, CR, LF — a name is one line).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
// Characters that render as nothing (or reorder the text around them) and carry no meaning in a
// name: zero-width space, the bidi EMBEDDING / OVERRIDE controls U+202A–202E (a right-to-left
// override reorders everything after it), word joiner and the deprecated format controls
// U+2060–206F, soft hyphen, BOM, the Hangul fillers (category Lo — LETTERS — so a name made only
// of them used to pass hasSubstance() and render blank), combining grapheme joiner, the Khmer
// inherent vowels, the Mongolian free variation selectors, the interlinear annotation marks,
// the musical-symbol format controls and the Unicode TAG block (U+E0000–E007F — a hidden-text
// channel). Needs the `u` flag to see past U+FFFF.
// Kept: ZWJ / ZWNJ (U+200D / U+200C — emoji sequences, Persian, Indic), variation selectors
// (emoji; the ideographic ones are real Japanese names) and — for ACCOUNT names — the
// directional marks below.
// Single source of truth (independent audit, Section 5): the employer-leads controller keeps its
// own copy of this list and used to be the only one with the Hangul / bidi-override entries.
const INVISIBLE_FILLER = /[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/gu
// LRM, RLM and ARABIC LETTER MARK: direction-changing but legitimately part of Persian / Arabic /
// Hebrew names, so account names keep them. Text typed by a STRANGER (employer leads) drops them
// too — see cleanStrangerText.
const DIRECTIONAL_MARKS = /[\u061c\u200e\u200f]/g
const LINE_SEPARATORS = /[\u2028\u2029]/g

function cleanName(input) {
  return String(input ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(LINE_SEPARATORS, ' ')
    .replace(INVISIBLE_FILLER, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Stricter variant for text a stranger submits to us (employer leads): also drops the directional
// marks, because it lands in an admin table and an email where reordering it is only ever abuse.
function cleanStrangerText(input) {
  return cleanName(String(input ?? '').replace(DIRECTIONAL_MARKS, ''))
}

// Free text that keeps its line breaks (lead notes): same dangerous-character removal, no
// whitespace squeeze.
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
function cleanNotes(input) {
  return String(input ?? '').replace(NOTE_CONTROL_CHARS, '').replace(INVISIBLE_FILLER, '').replace(DIRECTIONAL_MARKS, '').trim()
}

// The first word of a name, cleaned — what the PUBLIC verification page shows. Null when there is
// no real word (so the page falls back to "no name" instead of a blank or a reordered heading).
function firstNameOf(input) {
  // A parsed resume can hand back anything (an object stringifies to letters): only text counts.
  if (typeof input !== 'string') return null
  const first = cleanName(input).split(' ')[0] || ''
  return hasSubstance(first) ? first : null
}

// ROUND-6 AUDIT FIX (bug, Section 7): firstNameOf kept ANY single token, however long and whatever it
// said, and the result is printed under "Passthrough Verified" on the public page and in the link
// preview. A resume whose "name" is one token such as `https://pay.example/claim-your-prize-...`
// (or 400 letters) became the page's headline name: scam text on a branded page, and a heading that
// overflowed its card. What the PUBLIC page may show is stricter than what is stored: a plausible
// first name is short, is not a link / address / domain, and carries no phone-number-sized digit run.
// Applied when the page is read (so pages issued before this change are covered too) AND when the
// name is derived. Returns null when the token fails — the page then shows no name.
const MAX_PUBLIC_NAME_CHARS = 40
function isPublicSafeName(first) {
  if (typeof first !== 'string' || !first) return false
  if ([...first].length > MAX_PUBLIC_NAME_CHARS) return false
  if (/:\/\/|@|www\./i.test(first)) return false                       // link, e-mail address
  if (/[\p{L}\p{N}][.][\p{L}]{2,}/u.test(first)) return false            // a domain: "pay.example", "x.co" is rejected, "J.R." is not
  if (/\d[\d\s().+-]*\d/.test(first) && (first.match(/\d/g) || []).length >= 5) return false   // phone number
  return true
}
function publicFirstName(input) {
  const first = firstNameOf(input)
  return first && isPublicSafeName(first) ? first : null
}

// A name has to contain at least one letter or digit in some script — "  ",
// "\u200b", "---" and "🙂" are not names. Unicode-aware, so "李", "Åsa" and
// "محمد" all pass.
const hasSubstance = (s) => /[\p{L}\p{N}]/u.test(s)

// One definition for register and updateName. The clean-then-validate order
// matters: length limits and "is it empty" are judged on what will actually be
// stored, not on what was typed.
const nameSchema = z.string()
  .transform(cleanName)
  .pipe(z.string().min(1, 'Name is required.').max(100, 'Name must be 100 characters or fewer.')
    .refine(hasSubstance, 'Enter a valid name.'))

module.exports = { cleanName, cleanStrangerText, cleanNotes, firstNameOf, publicFirstName, isPublicSafeName, MAX_PUBLIC_NAME_CHARS, hasSubstance, nameSchema }
