// Trivial port — same logic, Hono signature.

function roleGuard(role) {
  return async (c, next) => {
    const user = c.get('user')
    if (!user) return c.json({ success: false, message: 'Auth required' }, 401)
    if (user.role !== role) return c.json({ success: false, message: 'Forbidden' }, 403)
    return next()
  }
}

module.exports = roleGuard
