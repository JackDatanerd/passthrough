// Shared cleaning for short human-entered text that ends up in emails, page
// headings and documents. Kept deliberately conservative: it removes what can
// only ever be an accident or an attack (control characters, invisible
// filler) and leaves everything a real name can contain — including the
// zero-width joiners / non-joiners and directional marks that Persian, Indic
// and Arabic-script names genuinely need.
const { z } = require('zod')

// C0 / C1 control characters (incl. tab, CR, LF — a name is one line).
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
// Characters that render as nothing and carry no meaning in a name:
// zero-width space, word joiner, soft hyphen, BOM/zero-width no-break space,
// line and paragraph separators.
const INVISIBLE_FILLER = /[\u200b\u2060\u00ad\ufeff]/g
const LINE_SEPARATORS = /[\u2028\u2029]/g

function cleanName(input) {
  return String(input ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(LINE_SEPARATORS, ' ')
    .replace(INVISIBLE_FILLER, '')
    .replace(/\s+/g, ' ')
    .trim()
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

module.exports = { cleanName, hasSubstance, nameSchema }
