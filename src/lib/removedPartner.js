// A partner whose personal data was removed (partners.controller.js adminAnonymizePartner) keeps their row —
// payout and commission records have to stay — but with a placeholder address on a reserved, undeliverable domain
// (RFC 2606 `.invalid`). Mail to such an address must never be attempted: a refund landing after removal, or an
// admin action on the row, would otherwise fire a send that can only fail and be logged as a failure.
const REMOVED_EMAIL_DOMAIN = 'removed.invalid'
const isRemovedEmail = email => String(email || '').trim().toLowerCase().endsWith(`@${REMOVED_EMAIL_DOMAIN}`)
module.exports = { REMOVED_EMAIL_DOMAIN, isRemovedEmail }
