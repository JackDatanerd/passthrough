const { Hono } = require('hono')
const auth         = require('../middleware/auth')
const rl           = require('../middleware/rateLimiter')
const c            = require('../controllers/auth.controller')

const router = new Hono()

router.post('/register',            rl.auth, c.register)
// authLogin = the `auth` bucket, but a successful sign-in gives its slot back.
router.post('/login',               rl.authLogin, c.login)
router.get( '/me',                  auth,    c.getMe)
router.post('/forgot-password',     rl.auth, c.forgotPassword)
router.post('/reset-password',      rl.auth, c.resetPassword)
// FEATURE (Auth/Scan round): lets the reset page report a dead link up front.
// Link-click posture (not credential guessing) — same looser bucket as /verify-email.
router.get( '/reset-password/validate', rl.authVerify, c.checkResetToken)
// HARDENING: moved off the shared 10/15min `rl.auth` credential bucket onto
// the looser `rl.authVerify` bucket — these are link-click/resend flows,
// not credential guessing, and were previously eating into the same budget
// as login attempts. See rateLimiter.js's authVerify comment.
router.get( '/verify-email',        rl.authVerify, c.verifyEmail)
router.post('/resend-verification', auth, rl.authVerify, c.resendVerification)
router.patch('/password',           auth, rl.auth, c.changePassword)
// FEATURE (Auth section audit): no password required — see the controller's
// comment — so this stays on the general per-route limit only, same
// posture as /name below.
router.post('/sessions/revoke-others', auth, c.signOutOtherSessions)
// Server-side sessions (migration 0047): sign out, list devices, sign one out.
// No password (it only narrows what the caller's own verified session can do),
// so the general per-route limit applies, same posture as revoke-others above.
router.post('/logout',               auth, c.logout)
router.get( '/sessions',             auth, c.listSessions)
router.delete('/sessions/:id',       auth, c.revokeSession)
// AUDIT FIX (Section 6): Settings had no way to change name or email —
// no route existed for either. /email shares the tighter `rl.auth`
// credential-adjacent bucket with /password and /account since it also
// requires the current password; /name doesn't, so it stays on the
// general per-route rate limit only.
// FEATURE GAP CLOSED (Auth section, second independent pass): companion route
// to safeUser()'s termsCurrent flag — no password needed (see the
// controller's own comment), so this stays on the general per-route limit
// only, same posture as /name.
router.post('/accept-terms',        auth,          c.acceptTerms)
router.patch('/name',               auth,          c.updateName)
router.patch('/email',              auth, rl.auth,  c.updateEmail)
// Public, token-gated (same posture as /verify-email) — the confirmation
// link is opened from an email client, which may not carry the original
// session. Shares /verify-email's looser bucket for the same reason its own
// comment gives: a link click isn't credential guessing.
router.post('/email/confirm',       rl.authVerify, c.confirmEmailChange)
router.delete('/account',           auth, rl.auth, c.deleteAccount)
router.post('/claim-scan',          auth,    c.claimScan)

module.exports = router
