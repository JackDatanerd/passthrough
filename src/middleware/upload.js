// Replaces Multer's diskStorage middleware. Hono has no file-upload library
// to chain — the multipart body is parsed here, in one pass, and both the file
// and the other form fields are attached to context, so the controller never
// touches the request body itself.
//
// What this guarantees before a single byte reaches the controller:
//   * the body is read through a byte-counting reader that ABORTS the moment it
//     crosses the cap — a Content-Length header is only an early-out, never
//     the defence. (A chunked upload has no Content-Length at all, and used to
//     be buffered whole — up to the platform's ~100MB request limit — against
//     a 128MB Worker.)
//   * the file's type is decided from its CONTENT, not from the browser's
//     `file.type` label. That label is client-supplied (spoofable) and, worse,
//     unreliable for honest users: Windows machines without Office report ''
//     or application/octet-stream for a perfectly valid .docx.
//   * every text field is really a string and is bounded.

const c = require('../config/constants')

const PDF_MIME  = 'application/pdf'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const MAX_FILE_BYTES = c.MAX_UPLOAD_MB * 1024 * 1024
// File cap plus a fixed allowance for the other multipart fields (job
// description text, brain-dump text) and boundary overhead.
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + (1 * 1024 * 1024)

// Free-text fields the scan pipeline slices down itself (MAX_JD_CHARS /
// MAX_RESUME_CHARS) — truncated, not rejected, so pasting a long posting still
// works. The cap only keeps a multi-MB string from being copied around.
const TEXT_FIELD_CAP  = 100_000
const MAX_RESUME_JSON_CHARS = 100_000   // = lib/resumeData.js MAX_RESUME_DATA_JSON_CHARS
const URL_MAX_CHARS   = 2048     // the practical URL limit; anything longer is not a job link
const NAME_MAX_CHARS  = 100      // matches the account-name limit
const EMAIL_MAX_CHARS = 254      // RFC 5321 maximum

// "%PDF-" — the spec lets the header sit anywhere in the first 1024 bytes.
function isPdf(bytes) {
  const limit = Math.min(bytes.length - 4, 1024)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
        bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2D) return true
  }
  return false
}

// "PK\x03\x04" — the ZIP local-file header every DOCX starts with.
function isZip(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04
}

function bytesInclude(bytes, ascii) {
  const first = ascii.charCodeAt(0)
  const last = bytes.length - ascii.length
  for (let i = bytes.indexOf(first); i !== -1 && i <= last; i = bytes.indexOf(first, i + 1)) {
    let j = 1
    while (j < ascii.length && bytes[i + j] === ascii.charCodeAt(j)) j++
    if (j === ascii.length) return true
  }
  return false
}

// A DOCX is a ZIP whose entry list contains word/document.xml (in both the
// local header and the central directory, in plain ASCII). Any other ZIP —
// .xlsx, .pptx, a bare archive — is not a resume and is refused here rather
// than failing later inside the parser.
function detectType(bytes) {
  if (isPdf(bytes)) return PDF_MIME
  if (isZip(bytes) && bytesInclude(bytes, 'word/document.xml')) return DOCX_MIME
  return null
}

// Reads a request body into memory, refusing to buffer past maxBytes.
// Returns a Uint8Array, or null when the cap was exceeded.
async function readBodyCapped(request, maxBytes) {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch (_) {}
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
  return out
}

const tooLarge = ctx => ctx.json({ success: false, message: `File too large. Max ${c.MAX_UPLOAD_MB}MB.` }, 413)

async function uploadResume(ctx, next) {
  const contentLength = ctx.req.header('content-length')
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) return tooLarge(ctx)

  const contentType = ctx.req.header('content-type') || ''
  if (!/^multipart\/form-data/i.test(contentType))
    return ctx.json({ success: false, message: 'Invalid form data.' }, 400)

  let formData
  try {
    const bytes = await readBodyCapped(ctx.req.raw, MAX_REQUEST_BYTES)
    if (bytes === null) return tooLarge(ctx)
    formData = await new Response(bytes, { headers: { 'content-type': contentType } }).formData()
  } catch (_) {
    return ctx.json({ success: false, message: 'Invalid form data.' }, 400)
  }

  // A text field must be text. A part sent as a file (or repeated in some
  // odd shape) would otherwise reach the controller as a File object and
  // blow up its .trim() as an unhandled 500.
  function textField(name, cap) {
    const v = formData.get(name)
    if (v == null) return ''
    if (typeof v !== 'string') return null
    // Multipart form data carries every newline as CRLF (that is what browsers send), so a
    // 12,000-character box arrives as 12,000 + one extra character per line. Every cap below
    // and in the controller counts characters, so the extra CRs silently cut the END off a long
    // background or job posting that the form said fit. LF-only before anything is measured.
    return v.replace(/\r\n?/g, '\n').slice(0, cap)
  }

  const fields = {
    jobDescriptionText: textField('jobDescriptionText', TEXT_FIELD_CAP),
    jobDescriptionUrl:  textField('jobDescriptionUrl',  URL_MAX_CHARS + 1),
    // Brain-dump entry path: only one of `file` / `brainDumpText` is expected
    // per request; createScan is the single place that decides which mode
    // applies (and rejects if both or neither are present).
    brainDumpText:      textField('brainDumpText',      TEXT_FIELD_CAP),
    useSavedProfile:    textField('useSavedProfile',    10),
    // Rescan: the id of the person's earlier scan whose resume is reused (a UUID — createScan
    // validates it). This field used to be missing here, so the form's "same resume" submit
    // reached createScan with nothing in it and was rejected as "no input".
    sourceScanId:       textField('sourceScanId',       64),
    // Manual entry: the structured resume the person typed into the form themselves (JSON).
    // Validated, size-capped and shape-checked by lib/resumeData.js in createScan.
    resumeDataJson:     textField('resumeDataJson',     MAX_RESUME_JSON_CHARS + 1),
    // Explicit name/email for anonymous brain-dump submissions — see
    // createScan (validated there) for how these are used.
    contactName:        textField('contactName',        NAME_MAX_CHARS),
    contactEmail:       textField('contactEmail',       EMAIL_MAX_CHARS + 1)
  }
  if (Object.values(fields).some(v => v === null))
    return ctx.json({ success: false, message: 'Invalid form data.' }, 400)
  if (fields.resumeDataJson.length > MAX_RESUME_JSON_CHARS)
    return ctx.json({ success: false, message: 'Resume data is too large.' }, 400)
  if (fields.jobDescriptionUrl.length > URL_MAX_CHARS)
    return ctx.json({ success: false, message: 'That job link is too long.' }, 400)
  if (fields.contactEmail.length > EMAIL_MAX_CHARS)
    return ctx.json({ success: false, message: 'Enter a valid email address.' }, 400)
  ctx.set('formFields', fields)

  const file = formData.get('resume')
  if (!file || typeof file === 'string') {
    // A missing file is valid when brainDumpText is present. createScan is
    // where "neither provided" actually gets rejected.
    ctx.set('uploadedFile', null)
    return next()
  }

  // The label is only an early, friendly refusal for files that are plainly something else (a
  // screenshot, a video, a .txt). It never ACCEPTS anything — the bytes decide below — so any
  // label that isn't obviously the wrong kind of file goes on to the real check. An allow-list
  // here wrongly turned away genuine PDFs/DOCX whose label was merely unusual
  // (`binary/octet-stream` from some Android file pickers, a different case, a charset suffix).
  const label = String(file.type || '').toLowerCase().split(';')[0].trim()
  if (/^(image|video|audio|text|font)\//.test(label) || label === 'application/json' || label === 'application/xml')
    return ctx.json({ success: false, message: 'Only PDF and DOCX files accepted' }, 415)

  if (file.size === 0) return ctx.json({ success: false, message: 'That file is empty.' }, 400)
  if (file.size > MAX_FILE_BYTES) return tooLarge(ctx)

  const bytes = new Uint8Array(await file.arrayBuffer())
  const detected = detectType(bytes)
  if (!detected)
    return ctx.json({ success: false, message: 'File content does not match a valid PDF or DOCX.' }, 415)

  ctx.set('uploadedFile', {
    bytes,
    originalname: cleanFilename(file.name),
    mimetype:     detected,       // decided from the bytes, never from the client's label
    size:         file.size
  })

  return next()
}

// The stored name is shown back in the dashboard and the admin tools, so keep it to a plain
// base name: no directory parts, no control characters, and none of the bidirectional
// overrides (U+202A–202E, U+2066–2069, U+200E/F) that make "evil\u202Efdp.exe" display as
// "evilexe.pdf".
function cleanFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop()
  // Also the invisible and line-break characters that survive a plain control-character strip:
  // U+061C (Arabic letter mark, a bidi control), U+200B–200D (zero-width space/joiners), U+2060
  // (word joiner) and U+2028/2029 (line/paragraph separators). A name made only of these is empty.
  return base.replace(/[\u0000-\u001f\u007f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '').trim().slice(0, 255)
}

module.exports = uploadResume
module.exports.cleanFilename = cleanFilename
module.exports.detectType = detectType
module.exports.readBodyCapped = readBodyCapped
