// Run a promise after the response has been sent, without losing it.
//
// Cloudflare cancels in-flight work that was not handed to waitUntil() once the
// request ends (or the client disconnects). A bare `promise.then(...)` left
// floating therefore works "most of the time" — exactly the kind of bug that
// only shows up in production. Hono's `c.executionCtx` getter THROWS when no
// ExecutionContext exists (unit tests, some dev setups), so `c.executionCtx?.x`
// is not a safe guard — this wraps it properly.
//
// Returns true when the work was registered with waitUntil. When it wasn't,
// the promise is still running (it was started by the caller) — it is simply
// not protected from cancellation, which is the best available fallback.
function runInBackground(c, promise) {
  // A rejection here must never become an unhandled rejection.
  const safe = Promise.resolve(promise).catch(err => {
    console.error('Background task failed:', err && err.message)
  })
  try {
    c.executionCtx.waitUntil(safe)
    return true
  } catch (_) {
    return false
  }
}

module.exports = { runInBackground }
