// Global cap on request-body size for everything that is NOT a multipart
// upload (those are bounded by middleware/upload.js, which has a much larger,
// file-sized budget).
//
// Without this, any JSON endpoint would buffer whatever the client sent — up
// to the platform's ~100MB request limit — into a 128MB Worker. A
// Content-Length preflight alone is not a defence: a chunked request has no
// Content-Length, so when the length is unknown the body is wrapped in a
// byte-counting stream that errors the moment it crosses the cap. That error
// surfaces where the controller reads the body (`await c.req.json()`), and
// errorHandler.js renders it as a clean 413.
//
// Nothing legitimate here is large: the biggest JSON payload in the app is a
// structured resume, comfortably under 100KB.

const MAX_JSON_BYTES = 1 * 1024 * 1024

function tooLargeError() {
  const err = new Error('Request body too large.')
  err.status = 413
  err.expose = true
  return err
}

function bodyLimit(maxBytes = MAX_JSON_BYTES) {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()

    const contentType = (c.req.header('content-type') || '').toLowerCase()
    if (contentType.startsWith('multipart/form-data')) return next()   // upload.js owns this

    const declared = c.req.header('content-length')
    if (declared) {
      const size = Number(declared)
      if (!Number.isFinite(size) || size > maxBytes)
        return c.json({ success: false, message: 'Request body too large.' }, 413)
      return next()
    }

    const raw = c.req.raw
    if (raw && raw.body) {
      let total = 0
      const limited = raw.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          total += chunk.byteLength
          if (total > maxBytes) controller.error(tooLargeError())
          else controller.enqueue(chunk)
        }
      }))
      c.req.raw = new Request(raw, { body: limited, duplex: 'half' })
    }
    return next()
  }
}

module.exports = bodyLimit
module.exports.MAX_JSON_BYTES = MAX_JSON_BYTES
