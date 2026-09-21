// Resume-upload validation, shared by <FileUpload>. Pure so it can be tested.

export const ALLOWED_UPLOADS = {
  pdf:  'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function extensionOf(name) {
  const i = String(name || '').lastIndexOf('.')
  return i === -1 ? '' : String(name).slice(i + 1).toLowerCase()
}

export function validateUpload(file, maxMB = 5) {
  if (!file) return 'No file selected.'
  const ext = extensionOf(file.name)
  if (!ALLOWED_UPLOADS[ext]) return 'Only PDF and DOCX files are accepted.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > maxMB * 1024 * 1024) return `File too large. Max ${maxMB}MB.`
  return null
}

// The client validates by extension but the API validates `file.type`. Some
// Windows/Android pickers report an empty or generic ("application/octet-stream")
// type for a perfectly good .docx, which the API then rejects with 415. Re-wrap
// the file with the correct MIME type so both sides agree.
export function normalizeUpload(file) {
  const expected = ALLOWED_UPLOADS[extensionOf(file.name)]
  if (!expected || file.type === expected) return file
  return new File([file], file.name, { type: expected, lastModified: file.lastModified })
}
