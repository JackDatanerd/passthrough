// Replaces config/storage.js (local disk path helpers). R2 has no directories
// to create — object keys are just strings with '/' as a visual separator.
// All functions here only build keys; src/services use env.RESUMES_BUCKET
// directly to put/get/delete objects by these keys.

function resumeKey(scanId, ext) {
  return `resumes/${scanId}${ext}`
}

function atsDocxKey(scanId) {
  return `generated/${scanId}-ats.docx`
}

function beautifulPdfKey(scanId) {
  return `generated/${scanId}-beautiful.pdf`
}

module.exports = { resumeKey, atsDocxKey, beautifulPdfKey }
