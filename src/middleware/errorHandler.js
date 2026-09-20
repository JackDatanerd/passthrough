// Replaces Express's 4-arg error middleware with Hono's app.onError(err, c)
// handler, registered once in src/index.js. Multer-specific branches
// (LIMIT_FILE_SIZE, MulterError) are gone — upload.js now returns its own
// 413/415 responses directly instead of throwing, since there's no Multer
// error-passing convention to replicate. Zod validation errors are unchanged.
//
// Prisma's unique-constraint code 'P2002' has no equivalent in Supabase —
// Postgres itself returns SQLSTATE '23505' (unique_violation) via PostgREST,
// surfaced on error.code from the supabase-js client. That's the new check.

const c = require('../config/constants')

function errorHandler(err, ctx) {
  if (err.name === 'ZodError')
    return ctx.json({ success: false, message: 'Validation failed',
      errors: err.errors.map(e => ({ field: e.path.join('.'), message: e.message })) }, 400)

  // Postgres unique_violation — replaces Prisma's P2002
  if (err.code === '23505')
    return ctx.json({ success: false, message: 'Already exists.' }, 409)

  // AUDIT FIX (Section 9): used to log only err.message. `wrangler tail` is
  // the only place a production incident can be root-caused from, and the
  // stack trace is the one thing on `err` that actually points at where it
  // happened — dropping it made every unhandled error here strictly less
  // debuggable than the queue consumer in index.js, which already captures
  // err.stack when it alerts the owner.
  console.error('Unhandled error:', err.stack || err.message)
  return ctx.json({ success: false,
    message: ctx.env.NODE_ENV === 'production' ? 'An error occurred.' : err.message
  }, err.status || 500)
}

module.exports = errorHandler
