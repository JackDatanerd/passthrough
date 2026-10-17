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

module.exports = { nameStem, nameSlug, resumeStem, draftStem, coverLetterStem }
