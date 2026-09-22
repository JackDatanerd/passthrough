// Replaces config/storage.js (local disk path helpers). R2 has no directories
// to create — object keys are just strings with '/' as a visual separator.
// All functions here only build keys; src/services use env.RESUMES_BUCKET
// directly to put/get/delete objects by these keys.

function resumeKey(scanId, ext) {
  return `resumes/${scanId}${ext}`
}

// SECTION 7 AUDIT FIX: generated files now get a per-generation `version`
// token. They used to live at ONE fixed key per scan, so a retry overwrote the
// delivered DOCX in R2 tens of seconds BEFORE the DB row's hash/path were
// updated (the PDF render sits in between) — for that whole window, and
// permanently if the job died there, the public verification page compared
// the NEW bytes against the OLD hash and reported a genuine file as
// "Modified". With a fresh key per generation, the old object stays valid
// until the DB row is atomically repointed at the new one, and is only then
// deleted. `version` is optional so legacy rows (which store the unversioned
// key in the DB) keep resolving.
function atsDocxKey(scanId, version) {
  return version ? `generated/${scanId}-ats-${version}.docx` : `generated/${scanId}-ats.docx`
}

function beautifulPdfKey(scanId, version) {
  return version ? `generated/${scanId}-beautiful-${version}.pdf` : `generated/${scanId}-beautiful.pdf`
}

module.exports = { resumeKey, atsDocxKey, beautifulPdfKey }
