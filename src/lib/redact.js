// Log hygiene: keep personal data out of Workers Logs (which have their own retention and access list,
// separate from the database's). AUDIT FIX (Cross-cutting infra, B3).

// "jane.doe@example.com" -> "j***@example.com" — enough to correlate with an email_logs row, not enough
// to read the address out of a log line.
function maskEmail(addr) {
  const s = String(addr == null ? '' : addr)
  const at = s.lastIndexOf('@')
  if (at < 1) return s ? '***' : ''
  return `${s[0]}***${s.slice(at)}`
}

// Postgres unique-violation `details` look like: Key (email)=(jane@example.com) already exists.
// Keep the column names (they identify WHICH constraint) and drop the values.
function redactPgDetails(details) {
  if (typeof details !== 'string' || !details) return ''
  return details.replace(/\)=\((.*)\)(?= already exists)/s, ')=([redacted])')
}

module.exports = { maskEmail, redactPgDetails }
