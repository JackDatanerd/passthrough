// Mailbox identity for the employer-lead do-not-contact list and per-recipient mail caps.
//
// WHY THIS EXISTS (employer leads, round 11, G1/G8)
//   * "bob@gmail.com", "bob+anything@gmail.com" and "b.o.b@googlemail.com" are ONE inbox. The
//     suppression hash and the per-address mail caps used to key on the exact string, so a person who
//     removed themselves was not covered at an alias, and anyone could type `victim+1@…`, `victim+2@…`
//     into the public form and get a fresh cap (and a fresh lead) per variant — mail into one inbox.
//     `canonicalMailbox` is the identity used for CAPS and SUPPRESSION CHECKS only. Leads are still
//     stored under the address as typed (an employer may use hiring+eng@ on purpose).
//   * The do-not-contact table stores only a hash, but an unsalted SHA-256 of an email address is
//     reversible for any guessable address. With SUPPRESSION_HASH_KEY set, new entries are an HMAC
//     under that key instead; lookups check both forms (and SUPPRESSION_HASH_KEY_PREVIOUS while a key
//     is being rotated), so entries written before the key existed keep working.

const { sha256 } = require('./crypto')

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])
const enc = new TextEncoder()

function normalizeMailbox(email) { return String(email == null ? '' : email).trim().toLowerCase() }

// The mailbox an address delivers to, as far as can be known without asking the provider:
//   * a `+tag` suffix on the local part is dropped (every major provider treats it as the same inbox);
//   * Gmail / Googlemail additionally ignore dots in the local part and are one domain.
// Anything that would leave an empty local part is returned unchanged.
function canonicalMailbox(email) {
  const e = normalizeMailbox(email)
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (GMAIL_DOMAINS.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com' }
  return local ? `${local}@${domain}` : e
}

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(text))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const hashKeys = (env) => ({
  current: env && env.SUPPRESSION_HASH_KEY ? String(env.SUPPRESSION_HASH_KEY) : '',
  previous: env && env.SUPPRESSION_HASH_KEY_PREVIOUS ? String(env.SUPPRESSION_HASH_KEY_PREVIOUS) : ''
})

// { write, read } — hashes to RECORD for an address, and hashes to LOOK UP. Both cover the address as
// typed and its canonical mailbox. `write[0]` is always the hash of the address as typed, in the
// current form: the stable id for audit entries ("which suppression", never the address itself).
async function suppressionHashes(env, email) {
  const exact = normalizeMailbox(email)
  const forms = [...new Set([exact, canonicalMailbox(exact)])]
  const { current, previous } = hashKeys(env)
  const plain = await Promise.all(forms.map(f => sha256(f)))
  if (!current) return { write: plain, read: plain }
  const keyed = await Promise.all(forms.map(f => hmacHex(current, f)))
  const old = previous ? await Promise.all(forms.map(f => hmacHex(previous, f))) : []
  return { write: keyed, read: [...new Set([...keyed, ...old, ...plain])] }
}

module.exports = { canonicalMailbox, suppressionHashes, normalizeMailbox }
