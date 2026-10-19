// File names for the documents an applicant downloads. One accent-aware transliteration shared by every download, so a
// name like "José Núñez" is "Jose-Nunez-Resume" everywhere — the profile download used to skip the combining-mark strip
// and produced "jose-nu-n-ez-resume".

const plain = name => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')

// "Jane Doe" -> "Jane-Doe"; nothing usable (no Latin letters or digits) -> ''.
function nameStem(name) {
  return plain(name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}
function nameSlug(name) { return nameStem(name).toLowerCase() }

const resumeStem      = name => { const s = nameStem(name); return s ? `${s}-Resume` : 'Resume' }
const draftStem       = name => { const s = nameSlug(name); return s ? `${s}-resume-draft` : 'resume-draft' }
const coverLetterStem = name => { const s = nameSlug(name); return s ? `${s}-cover-letter` : 'cover-letter' }

// The Content-Disposition header for a download. The plain filename is the ASCII stem (accents folded: "Jose-Nunez-Resume.pdf"), as before.
// When the name has letters that folding cannot reach (Cyrillic, Greek, CJK, Arabic, Amharic ... or a mixed name like "Анна Smith"), the
// real name is also sent as an RFC 5987 filename* so the file is called "Анна-Иванова-Resume.pdf" instead of an identical "Resume.pdf" for
// every such applicant (the frontend's filenameFromDisposition already prefers filename*). Only letters, numbers and combining marks of
// any script survive into it - no path characters, quotes or controls - and it is percent-encoded.
const rfc5987 = v => encodeURIComponent(v).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const NON_ASCII_LETTER = /[^\x00-\x7F]/
function disposition(kind, name, ext) {
  const asciiStem = { resume: resumeStem, draft: draftStem, letter: coverLetterStem }[kind](name)
  const header = `attachment; filename="${asciiStem}.${ext}"`
  const folded = plain(name).replace(/[^\p{L}\p{N}]+/gu, '')
  if (!NON_ASCII_LETTER.test(folded)) return header                    // Latin names: the folded ASCII name says it all
  const base = [...String(name || '').normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '')].slice(0, 40).join('').replace(/-+$/, '')
  if (!base) return header
  const suffix = { resume: '-Resume', draft: '-resume-draft', letter: '-cover-letter' }[kind]
  return `${header}; filename*=UTF-8''${rfc5987(`${kind === 'resume' ? base : base.toLowerCase()}${suffix}.${ext}`)}`
}

module.exports = { nameStem, nameSlug, resumeStem, draftStem, coverLetterStem, disposition }
