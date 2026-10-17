// Read a request body with a hard byte cap WHILE streaming, so a chunked request with no Content-Length can never make the
// Worker buffer more than `max` bytes before it is refused. Returns a Uint8Array, or null when the body is over the cap.
// Falls back to arrayBuffer() where no stream is exposed (unit-test doubles); the cap is still enforced on the result.
async function readBodyCapped(c, max) {
  const body = c && c.req && c.req.raw && c.req.raw.body
  if (!body || typeof body.getReader !== 'function') {
    const all = new Uint8Array(await c.req.arrayBuffer())
    return all.byteLength > max ? null : all
  }
  const reader = body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { try { await reader.cancel() } catch (_) { /* already closing */ } return null }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength }
  return out
}

module.exports = { readBodyCapped }
