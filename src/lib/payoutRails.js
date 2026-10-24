'use strict'

// Payout rails for partners anywhere (Western-market round). The payout_method enum keeps its three values
// (BANK, MOBILE_MONEY, PAYPAL); what differs by country lives INSIDE the BANK details, so no schema change is
// needed for a new country:
//
//   bankCountry   2-letter code of the country the account is held in
//   routingCode   US ABA routing number (9), UK sort code (6), AU BSB (6), CA transit + institution (5 + 3)
//   accountNumber the account number, or the whole IBAN in an IBAN country (so every place that already shows
//                 "the account number" - masks, last four, CSV, audit hints - keeps working)
//   swiftBic      8 or 11 characters; required where no local rail or IBAN applies, optional elsewhere
//
// A BANK submission with no bankCountry keeps the old behaviour (a free-form account number), so details saved
// before this existed stay valid and the API stays backward compatible. The partner form always sends it.

const METHOD_LABELS = { BANK: 'Bank transfer', MOBILE_MONEY: 'Mobile money', PAYPAL: 'PayPal' }
const methodLabel = m => METHOD_LABELS[m] || ''
const methodLabelLower = m => ({ BANK: 'a bank transfer', MOBILE_MONEY: 'mobile money', PAYPAL: 'PayPal' }[m] || 'an unknown method')

// Countries whose accounts are addressed by IBAN (SEPA area, the rest of Europe's IBAN users, GB).
const IBAN_COUNTRIES = new Set(('AD AT BE BG CH CY CZ DE DK EE ES FI FR GB GI GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO SE SI SK SM VA').split(' '))
// Domestic routing rails.
const LOCAL_RAIL_COUNTRIES = new Set(['US', 'GB', 'AU', 'CA'])

const digitsOnly = v => String(v == null ? '' : v).replace(/[\s-]/g, '')

// ABA routing number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be a multiple of 10.
function validAbaRouting(v) {
  const d = digitsOnly(v)
  if (!/^\d{9}$/.test(d)) return false
  const n = d.split('').map(Number)
  const sum = 3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])
  return sum % 10 === 0
}

// ISO 13616 mod-97 check, done in chunks so no BigInt is needed.
function validIban(v) {
  const s = String(v || '').replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const code = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const digit of code) rem = (rem * 10 + Number(digit)) % 97
  }
  return rem === 1
}

const validSwiftBic = v => /^[A-Za-z]{4}[A-Za-z]{2}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/.test(String(v || '').replace(/\s+/g, ''))

// What a routing code must look like in each country (digits only once spaces and dashes are removed).
const ROUTING_RULES = {
  US: { label: 'ACH routing number', test: validAbaRouting, hint: 'the 9-digit ACH routing number (ABA)' },
  GB: { label: 'sort code', test: v => /^\d{6}$/.test(digitsOnly(v)), hint: 'the 6-digit sort code, e.g. 20-00-00' },
  AU: { label: 'BSB', test: v => /^\d{6}$/.test(digitsOnly(v)), hint: 'the 6-digit BSB, e.g. 062-000' },
  // The order is what makes it safe: 8 bare digits cannot say which half is the transit number, so the dash is required (transit-institution).
  CA: { label: 'transit and institution number', test: v => /^\d{5}\s*-\s*\d{3}$/.test(String(v).trim()), hint: 'the 5-digit transit number, a dash, then the 3-digit institution number, e.g. 12345-678' }
}
const DOMESTIC_ACCOUNT_RE = { US: /^\d{4,17}$/, GB: /^\d{6,8}$/, AU: /^\d{5,10}$/, CA: /^\d{7,12}$/ }
// UK building-society accounts are identified by a roll number that may hold letters (up to 18 characters) instead of an 8-digit account number.
const GB_ROLL_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{3,17}$/
// New Zealand has no separate routing code: the account number IS bank-branch-account-suffix (2-4-7-2 or 3 digits, 15 or 16 in all).
const ACCOUNT_ONLY_RULES = { NZ: { label: 'account number', test: v => /^\d{15,16}$/.test(digitsOnly(v)), hint: 'the full account number with bank, branch, account and suffix, e.g. 12-3456-7890123-00' } }
// A routing code is only ever digits, spaces and dashes; checked even when the country is unknown so a stray value can't be stored.
const GENERIC_ROUTING_RE = /^[0-9][0-9 -]{3,19}$/

// Whether an account number is to be read as an IBAN. Most IBAN countries have no other format. The UK also has sort code + account number
// and building-society roll numbers, which can START with letters and digits ("AB12 3456 78"), so there it takes the real start of a UK IBAN:
// GB, two check digits, then four bank letters.
function readsAsIban(country, acct) {
  if (!IBAN_COUNTRIES.has(country)) return false
  if (!LOCAL_RAIL_COUNTRIES.has(country)) return true
  return new RegExp(`^${country}\\d{2}[A-Za-z]{4}`, 'i').test(String(acct || '').replace(/\s+/g, ''))
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// Returns an array of { path, message } problems for a BANK submission (empty = fine). Used from a zod superRefine.
function bankRailProblems(d) {
  const out = []
  const country = String(d.bankCountry || '').toUpperCase()
  if (d.swiftBic && !validSwiftBic(d.swiftBic)) out.push({ path: 'swiftBic', message: 'Enter the SWIFT/BIC as 8 or 11 letters and digits, e.g. CHASUS33.' })
  if (d.routingCode && !GENERIC_ROUTING_RE.test(String(d.routingCode))) out.push({ path: 'routingCode', message: 'A routing code is made of digits only (spaces and dashes are fine).' })
  if (!country) return out   // legacy / API submission without a country: free-form account number, as before

  const acct = String(d.accountNumber || '')

  // A UK account may be given as sort code + account number or as an IBAN.
  if (readsAsIban(country, acct)) {
    if (!validIban(acct)) out.push({ path: 'accountNumber', message: 'That IBAN doesn\u2019t look right. Check it and enter it in full, e.g. DE89 3704 0044 0532 0130 00.' })
    else if (acct.replace(/\s+/g, '').slice(0, 2).toUpperCase() !== country)
      out.push({ path: 'accountNumber', message: 'The IBAN must start with the country the account is held in.' })
    return out
  }
  const rule = ROUTING_RULES[country]
  if (rule) {
    if (!d.routingCode) out.push({ path: 'routingCode', message: `Enter your ${rule.label} (${rule.hint}).` })
    else if (!rule.test(d.routingCode)) out.push({ path: 'routingCode', message: `That ${rule.label} doesn\u2019t look right \u2014 it should be ${rule.hint}.` })
    const accountOk = DOMESTIC_ACCOUNT_RE[country].test(digitsOnly(acct)) || (country === 'GB' && GB_ROLL_NUMBER_RE.test(acct))
    if (!accountOk) out.push({ path: 'accountNumber', message: country === 'GB'
      ? 'That account number doesn\u2019t look right \u2014 UK accounts have 8 digits (building society roll numbers can include letters).'
      : 'That account number doesn\u2019t look right for the country you chose \u2014 digits only.' })
    return out
  }
  const accountOnly = ACCOUNT_ONLY_RULES[country]
  if (accountOnly) {
    if (!accountOnly.test(acct)) out.push({ path: 'accountNumber', message: `That account number doesn\u2019t look right \u2014 it should be ${accountOnly.hint}.` })
    return out
  }
  // Any other country: an international transfer needs the SWIFT/BIC.
  if (!d.swiftBic) out.push({ path: 'swiftBic', message: 'Enter your bank\u2019s SWIFT/BIC code \u2014 international transfers need it.' })
  return out
}

// What gets stored: empty optional strings are dropped, and a routing code that doesn't belong to the chosen rail is left out.
function cleanBankDetails(d) {
  const out = { ...d }
  for (const k of ['bankCountry', 'routingCode', 'swiftBic']) if (out[k] === '' || out[k] == null) delete out[k]
  const country = String(out.bankCountry || '').trim().toUpperCase()
  if (country && (!ROUTING_RULES[country] || readsAsIban(country, out.accountNumber))) delete out.routingCode
  return out
}

// Shown to the account holder / admins without the whole number.
function maskedEmail(v) {
  const s = String(v || '').trim()
  const at = s.lastIndexOf('@')
  if (at < 1) return ''
  return `${s[0]}***${s.slice(at)}`
}

// The one string that identifies the destination account, whatever the method (used for "last four" hints, owner alerts and CSVs).
function accountIdentifier(details) {
  const d = details || {}
  return String(d.accountNumber || d.phoneNumber || d.paypalEmail || '').replace(/\s+/g, '')
}

// Round 37: the form accepts "chas us33" and "20 00 00" (the validators ignore spaces) but the value was STORED as typed, and the payout run
// CSV hands exactly that to whoever keys it into a bank portal. Store the canonical form, and drop optional keys that arrive empty (an empty
// string is a different key set from "absent", which the change-detection would read as an edit). The change check already ignores spaces
// and case, so an old value stored in the loose form is quietly rewritten to the canonical one the next time it is saved unchanged.
function canonicalPayoutDetails(details) {
  const out = { ...details }
  if (typeof out.swiftBic === 'string') out.swiftBic = out.swiftBic.replace(/\s+/g, '').toUpperCase()
  if (typeof out.routingCode === 'string') out.routingCode = out.routingCode.replace(/\s+/g, '')
  if (typeof out.bankCountry === 'string') out.bankCountry = out.bankCountry.trim().toUpperCase()
  for (const k of ['swiftBic', 'routingCode', 'bankCountry']) if (k in out && !out[k]) delete out[k]
  return out
}

module.exports = {
  canonicalPayoutDetails, cleanBankDetails,
  METHOD_LABELS, methodLabel, methodLabelLower, IBAN_COUNTRIES, LOCAL_RAIL_COUNTRIES,
  validAbaRouting, validIban, validSwiftBic, bankRailProblems, maskedEmail, accountIdentifier, EMAIL_RE
}
