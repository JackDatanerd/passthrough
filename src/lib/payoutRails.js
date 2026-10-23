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
  CA: { label: 'transit and institution number', test: v => /^\d{8}$/.test(digitsOnly(v)), hint: 'the 5-digit transit number followed by the 3-digit institution number, e.g. 12345-678' }
}
const DOMESTIC_ACCOUNT_RE = { US: /^\d{4,17}$/, GB: /^\d{6,8}$/, AU: /^\d{5,10}$/, CA: /^\d{7,12}$/ }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// Returns an array of { path, message } problems for a BANK submission (empty = fine). Used from a zod superRefine.
function bankRailProblems(d) {
  const out = []
  const country = String(d.bankCountry || '').toUpperCase()
  if (d.swiftBic && !validSwiftBic(d.swiftBic)) out.push({ path: 'swiftBic', message: 'Enter the SWIFT/BIC as 8 or 11 letters and digits, e.g. CHASUS33.' })
  if (!country) return out   // legacy / API submission without a country: free-form account number, as before

  const acct = String(d.accountNumber || '')
  const ibanLooking = /^[A-Za-z]{2}\d{2}/.test(acct.replace(/\s+/g, ''))

  // A UK account may be given as sort code + account number or as an IBAN.
  if (IBAN_COUNTRIES.has(country) && (!LOCAL_RAIL_COUNTRIES.has(country) || ibanLooking)) {
    if (!validIban(acct)) out.push({ path: 'accountNumber', message: 'That IBAN doesn\u2019t look right. Check it and enter it in full, e.g. DE89 3704 0044 0532 0130 00.' })
    else if (acct.replace(/\s+/g, '').slice(0, 2).toUpperCase() !== country)
      out.push({ path: 'accountNumber', message: 'The IBAN must start with the country the account is held in.' })
    return out
  }
  const rule = ROUTING_RULES[country]
  if (rule) {
    if (!d.routingCode) out.push({ path: 'routingCode', message: `Enter your ${rule.label} (${rule.hint}).` })
    else if (!rule.test(d.routingCode)) out.push({ path: 'routingCode', message: `That ${rule.label} doesn\u2019t look right \u2014 it should be ${rule.hint}.` })
    if (!DOMESTIC_ACCOUNT_RE[country].test(digitsOnly(acct))) out.push({ path: 'accountNumber', message: 'That account number doesn\u2019t look right for the country you chose \u2014 digits only.' })
    return out
  }
  // Any other country: an international transfer needs the SWIFT/BIC.
  if (!d.swiftBic) out.push({ path: 'swiftBic', message: 'Enter your bank\u2019s SWIFT/BIC code \u2014 international transfers need it.' })
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

module.exports = {
  METHOD_LABELS, methodLabel, methodLabelLower, IBAN_COUNTRIES, LOCAL_RAIL_COUNTRIES,
  validAbaRouting, validIban, validSwiftBic, bankRailProblems, maskedEmail, accountIdentifier, EMAIL_RE
}
