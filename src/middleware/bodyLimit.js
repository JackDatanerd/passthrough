// Global cap on request-body size for everything that is NOT the one multipart
// upload route (that route is bounded by middleware/upload.js, which has a much
// larger, file-sized budget).
//
// Without this, any JSON endpoint would buffer whatever the client sent — up
// to the platform's ~100MB request limit — into a 128MB Worker. A
// Content-Length preflight alone is not a defence: a chunked request has no
// Content-Length, so when the length is unknown the body is wrapped in a
// byte-counting stream that errors the moment it crosses the cap. That error
// surfaces where the controller reads the body (`await c.req.json()`), and
// errorHandler.js renders it as a clean 413.
//
// The multipart exemption is scoped to the routes that actually run upload.js
// (MULTIPART_ROUTES). It used to be keyed off the Content-Type header alone —
// which the CLIENT chooses — so `Content-Type: multipart/form-data` on any JSON
// endpoint skipped the cap and the whole body was buffered by `c.req.json()`.
//
// Nothing legitimate here is large: the biggest JSON payload in the app is a
// structured resume, comfortably under 100KB.

const MAX_JSON_BYTES = 1 * 1024 * 1024

// method + path of every route that mounts middleware/upload.js
const MULTIPART_ROUTES = [{ method: 'POST', path: '/api/scan' }]

function tooLargeError() {
  const err = new Error('Request body too large.')
  err.status = 413
  err.expose = true
  return err
}

function pathOf(c) {
  let p = c.req.path
  if (typeof p !== 'string') {
    try { p = new URL(c.req.raw.url).pathname } catch (_) { p = '' }
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

function isMultipartRoute(c, routes) {
  const method = c.req.method
  const path = pathOf(c)
  return routes.some(r => r.method === method && r.path === path)
}

function bodyLimit(maxBytes = MAX_JSON_BYTES, { multipartRoutes = MULTIPART_ROUTES } = {}) {
  return async (c, next) => {
    // Tag a malformed-JSON failure as the CLIENT's mistake. errorHandler turns exactly these into
    // a 400; any other SyntaxError (an internal JSON.parse of an upstream reply, say) is a server
    // fault and must stay a logged 500 rather than being blamed on the caller.
    if (typeof c.req.json === 'function') {
      const readJson = c.req.json.bind(c.req)
      c.req.json = async () => {
        try { return await readJson() }
        catch (err) { if (err instanceof SyntaxError) err.clientBody = true; throw err }
      }
    }

    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()

    const contentType = (c.req.header('content-type') || '').toLowerCase()
    if (contentType.startsWith('multipart/form-data') && isMultipartRoute(c, multipartRoutes))
      return next()   // upload.js owns this

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
module.exports.MULTIPART_ROUTES = MULTIPART_ROUTES
