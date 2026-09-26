// FEATURE (Auth section, feature-gap-closing pass): every password form
// (Register, ResetPassword, Settings' change-password) previously only
// checked `.length < 8` before submitting — the server's real rules (a
// 72-BYTE ceiling, a common-password deny-list, "not your own email") only
// ever surfaced after a round trip. That's not a security gap (the server
// still enforces all of it regardless of what this file does), just a UX
// one: a person could fill in "password123", hit submit, and only then find
// out it's rejected.
//
// This is a deliberate, commented duplication of auth.controller.js's
// passwordSchema()/COMMON_PASSWORDS/passwordEmailProblem — there is no
// package shared between the Worker backend and this frontend build to put
// a single copy in, so keeping both in sync is a manual discipline. If one
// changes, the other must too:
//   - PASSWORD_MAX_BYTES / COMMON_PASSWORDS: src/controllers/auth.controller.js
//   - This file's job is ONLY to catch the common case early and show a
//     helpful message sooner. The server has — and must keep — the actual
//     authority; a mismatch here only ever means a slightly wrong message
//     shown for a moment before the server's real response replaces it, not
//     a security hole.

export const PASSWORD_MAX_BYTES = 72

// Mirrors auth.controller.js's COMMON_PASSWORDS exactly.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '11111111', '00000000', '88888888', '87654321', '123123123',
  'qwertyui', 'qwerty12', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx',
  'iloveyou', 'iloveyou1', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'changeme', 'trustno1',
  'abc12345', 'abcd1234', 'abcdefgh', 'monkey123', 'dragon123', 'football1', 'baseball1', 'superman1', 'sunshine1',
])

function byteLength(str) {
  return new TextEncoder().encode(str).length
}

// Mirrors auth.controller.js's passwordEmailProblem exactly.
function passwordEmailProblem(password, email) {
  if (!email) return null
  const pw = String(password).toLowerCase()
  const e = String(email).trim().toLowerCase()
  const local = e.split('@')[0]
  if (pw === e || (local.length >= 6 && pw === local)) return 'Your password can\'t be your email address.'
  return null
}

// Returns a user-facing message, or null if the password passes every check
// this file knows about. `email`, if passed, enables the "not your own
// email" check — omit it where the email isn't available yet or doesn't
// apply (e.g. the current-password field in a change-password form, which
// checkPasswordSchema on the backend never runs these rules against either).
export function passwordProblem(password, email) {
  if (!password) return 'Password is required.'
  if (password.length < 8) return 'Password must be at least 8 characters'
  if (byteLength(password) > PASSWORD_MAX_BYTES) {
    return 'Password is too long (max 72 bytes — some characters, like emoji or accented letters, count as more than one byte).'
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return 'That password is too common — choose something harder to guess.'
  }
  const emailProblem = passwordEmailProblem(password, email)
  if (emailProblem) return emailProblem
  return null
}
