// The one place the support address is decided (support-inboxes round 1).
//
// It used to be typed out in ~15 email templates, five payment messages and a dozen frontend files, with
// SUPPORT_EMAIL honoured by only four templates — so setting the variable changed almost nothing. Everything
// server-side now asks this module; the frontend has the same single source in frontend/src/lib/support.js.
//
// SUPPORT_EMAIL is the address customers are told to write to AND the Reply-To on customer mail. It is a mailbox
// that must actually receive (a Resend Inbox, see DEPLOYMENT.md §12) — EMAIL_FROM (hello@…) is only what mail is
// sent FROM.
const DEFAULT_SUPPORT_EMAIL = 'support@usepassthrough.com'

// "Dana Whitfield <dana@acme.com>" or "dana@acme.com" → "dana@acme.com" (lowercased), else null.
function bareAddress(raw) {
  if (typeof raw !== 'string') return null
  const angled = raw.match(/<([^<>]+)>\s*$/)
  const addr = (angled ? angled[1] : raw).trim().toLowerCase()
  return addr.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(addr) ? addr : null
}

// A malformed or blank SUPPORT_EMAIL must never put garbage in a customer's inbox — fall back to the default.
function supportEmail(env) {
  return bareAddress(env && env.SUPPORT_EMAIL) || DEFAULT_SUPPORT_EMAIL
}

// The bare address EMAIL_FROM sends from, or null when it is unset/malformed.
function fromAddress(env) {
  return bareAddress(env && env.EMAIL_FROM)
}

// Reply-To for customer mail: the support mailbox — unless that IS the sender, where the header says nothing new.
function replyToFor(env) {
  const support = supportEmail(env)
  return support === fromAddress(env) ? undefined : support
}

// Addresses that are ours (support + sender). Mail "from" one of these is never a customer.
function ownMailboxes(env) {
  return new Set([supportEmail(env), fromAddress(env)].filter(Boolean))
}

module.exports = { DEFAULT_SUPPORT_EMAIL, bareAddress, supportEmail, fromAddress, replyToFor, ownMailboxes }
