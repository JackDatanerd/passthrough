'use strict'

// Tax IDs are stored encrypted (AES-256-GCM), not as plain text. A partner's SSN / EIN / UTR / VAT number is the most sensitive value
// in the database: a leaked backup or a read-only database credential must not be enough to read it.
//
//   TAX_ID_ENCRYPTION_KEY   a Worker secret: 32 random bytes, base64 (generate with: openssl rand -base64 32)
//
// A sealed value looks like  enc:v1:<iv>:<ciphertext>  (base64). A value WITHOUT that prefix is a legacy plain-text row written before
// this existed: it is still read (so nothing breaks the moment this deploys) and is sealed by scripts/encrypt-tax-ids.cjs.
// With no usable key a tax ID is REFUSED on write rather than stored in clear: failing closed is the point.
const PREFIX = 'enc:v1:'

const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

let cached = { raw: null, key: null }
async function keyFor(env) {
  const raw = String((env && env.TAX_ID_ENCRYPTION_KEY) || '').trim()
  if (!raw) return null
  if (cached.raw === raw && cached.key) return cached.key
  let bytes
  try { bytes = fromB64(raw) } catch { return null }
  if (bytes.length !== 32) return null
  const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  cached = { raw, key }
  return key
}

const hasKey = async env => !!(await keyFor(env))
const isSealed = v => typeof v === 'string' && v.startsWith(PREFIX)

// -> the sealed string, or null when there is no usable key (the caller refuses the write).
async function sealTaxId(env, plain) {
  const key = await keyFor(env)
  if (!key) return null
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plain))))
  return `${PREFIX}${toB64(iv)}:${toB64(ct)}`
}

// -> the plain text, '' for nothing stored OR a value that cannot be read (no key, wrong key, damaged): never ciphertext.
async function openTaxId(env, stored) {
  if (stored == null || stored === '') return ''
  if (!isSealed(stored)) return String(stored)              // legacy plain-text row
  const key = await keyFor(env)
  if (!key) { console.error('tax id is sealed but TAX_ID_ENCRYPTION_KEY is missing or invalid'); return '' }
  try {
    const [iv, ct] = stored.slice(PREFIX.length).split(':')
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct)))
  } catch {
    console.error('tax id could not be decrypted (wrong key or damaged value)')
    return ''
  }
}

// Seals every legacy plain-text tax ID. Safe to re-run: sealed rows are skipped. Used by scripts/encrypt-tax-ids.cjs.
async function sealLegacyTaxIds(supabase, env, { apply = false } = {}) {
  if (!(await keyFor(env))) throw new Error('TAX_ID_ENCRYPTION_KEY is missing or is not 32 bytes of base64')
  let sealed = 0, skipped = 0, from = 0
  for (;;) {
    const { data, error } = await supabase.from('partners').select('id, tax_id').not('tax_id', 'is', null).order('id').range(from, from + 499)
    if (error) throw error
    if (!data || !data.length) break
    for (const row of data) {
      if (isSealed(row.tax_id)) { skipped++; continue }
      if (apply) {
        const { error: upErr } = await supabase.from('partners').update({ tax_id: await sealTaxId(env, row.tax_id) }).eq('id', row.id)
        if (upErr) throw upErr
      }
      sealed++
    }
    if (data.length < 500) break
    from += 500
  }
  return { sealed, skipped, applied: apply }
}

module.exports = { PREFIX, hasKey, isSealed, sealTaxId, openTaxId, sealLegacyTaxIds }
