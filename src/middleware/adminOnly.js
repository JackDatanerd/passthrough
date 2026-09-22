// Gates a route to users with role === 'ADMIN'. Does NOT verify the token
// itself — optionalAuth already runs app-wide (see index.js) and populates
// c.get('user') whenever a valid Bearer token is present, so this only adds
// the role check on top rather than duplicating auth.js's JWT verification.
//
// To make an existing account an admin: update its role in the `users`
// table directly (role_enum already has 'ADMIN' — see supabase/migrations/
// 0001_init.sql) — there's no self-serve promotion endpoint, intentionally.

async function adminOnly(c, next) {
  const user = c.get('user')
  if (!user) {
    // optionalAuth records why there is no user. If OUR user lookup failed,
    // this is a server-side hiccup, not a bad session: answer 503 so the SPA
    // (which signs the user out on any 401 that carried a token) keeps the
    // admin logged in and simply retries.
    const why = c.get('authError')
    if (why === 'unavailable')
      return c.json({ success: false, message: 'Could not verify your session right now. Please try again.' }, 503)
    if (why === 'expired')
      return c.json({ success: false, message: 'Session expired.', code: 'TOKEN_EXPIRED' }, 401)
    return c.json({ success: false, message: 'Authentication required' }, 401)
  }
  if (user.role !== 'ADMIN')
    return c.json({ success: false, message: 'Admin access required' }, 403)
  await next()
}

module.exports = adminOnly
