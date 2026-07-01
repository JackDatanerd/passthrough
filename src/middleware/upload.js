// Replaces Multer's diskStorage middleware. Hono has no file-upload library
// to chain — multipart bodies are parsed directly via c.req.formData(), which
// returns every field (file and text) from a single read of the request
// stream. Since the stream can only be consumed once, this middleware parses
// everything in one pass and attaches both the file and the other form
// fields to context, so the controller never touches c.req.formData() itself.
//
// Validation (MIME allowlist, 5MB size cap) is identical to v8's fileFilter
// + limits.fileSize. UUID filename generation moves to the controller, which
// already needs a fresh ID for the scan row anyway — see config/storage.js.

const c = require('../config/constants')

const ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]

async function uploadResume(ctx, next) {
  let formData
  try {
    formData = await ctx.req.formData()
  } catch (_) {
    return ctx.json({ success: false, message: 'Invalid form data.' }, 400)
  }

  const file = formData.get('resume')
  const fields = {
    jobDescriptionText: formData.get('jobDescriptionText') || '',
    jobDescriptionUrl:  formData.get('jobDescriptionUrl')  || ''
  }
  ctx.set('formFields', fields)

  if (!file || typeof file === 'string') {
    ctx.set('uploadedFile', null)
    return next() // controller returns 400 "Resume file is required." — same as v8
  }

  if (!ALLOWED_MIME.includes(file.type)) {
    const err = new Error('Only PDF and DOCX files accepted')
    err.status = 415
    return ctx.json({ success: false, message: err.message }, 415)
  }

  if (file.size > c.MAX_UPLOAD_MB * 1024 * 1024) {
    return ctx.json({ success: false,
      message: `File too large. Max ${c.MAX_UPLOAD_MB}MB.` }, 413)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  ctx.set('uploadedFile', {
    bytes,
    originalname: file.name,
    mimetype:     file.type,
    size:         file.size
  })

  return next()
}

module.exports = uploadResume
