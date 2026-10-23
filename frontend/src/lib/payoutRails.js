// Client mirror of src/lib/payoutRails.js (the server is the authority; this catches typos before a round trip).
// Where the account is held decides which routing details a bank payout needs.

export const BANK_COUNTRIES = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'], ['NZ', 'New Zealand'], ['IE', 'Ireland'],
  ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['IT', 'Italy'], ['NL', 'Netherlands'], ['BE', 'Belgium'], ['AT', 'Austria'],
  ['CH', 'Switzerland'], ['SE', 'Sweden'], ['NO', 'Norway'], ['DK', 'Denmark'], ['FI', 'Finland'], ['PT', 'Portugal'], ['PL', 'Poland'],
]
export const OTHER_COUNTRY = 'OTHER'

const IBAN_COUNTRIES = new Set('AD AT BE BG CH CY CZ DE DK EE ES FI FR GB GI GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO SE SI SK SM VA'.split(' '))
const digitsOnly = v => String(v == null ? '' : v).replace(/[\s-]/g, '')

export function validAbaRouting(v) {
  const d = digitsOnly(v)
  if (!/^\d{9}$/.test(d)) return false
  const n = d.split('').map(Number)
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0
}

export function validIban(v) {
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

export const validSwiftBic = v => /^[A-Za-z]{4}[A-Za-z]{2}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/.test(String(v || '').replace(/\s+/g, ''))

const ROUTING = {
  US: { label: 'ACH routing number', placeholder: '9 digits', hint: 'the 9-digit ACH routing number (ABA)', test: validAbaRouting },
  GB: { label: 'Sort code', placeholder: '20-00-00', hint: 'the 6-digit sort code, e.g. 20-00-00', test: v => /^\d{6}$/.test(digitsOnly(v)) },
  AU: { label: 'BSB', placeholder: '062-000', hint: 'the 6-digit BSB, e.g. 062-000', test: v => /^\d{6}$/.test(digitsOnly(v)) },
  CA: { label: 'Transit and institution number', placeholder: '12345-678', hint: 'the 5-digit transit number followed by the 3-digit institution number, e.g. 12345-678', test: v => /^\d{8}$/.test(digitsOnly(v)) },
}
const DOMESTIC_ACCOUNT = { US: /^\d{4,17}$/, GB: /^\d{6,8}$/, AU: /^\d{5,10}$/, CA: /^\d{7,12}$/ }

// 'routing' = domestic code + account number, 'iban' = IBAN only, 'swift' = account number + SWIFT/BIC.
export function bankRail(country, accountNumber = '') {
  const c = String(country || '').toUpperCase()
  if (IBAN_COUNTRIES.has(c) && (!ROUTING[c] || /^[A-Za-z]{2}\d{2}/.test(String(accountNumber).replace(/\s+/g, '')))) return 'iban'
  if (ROUTING[c]) return 'routing'
  return 'swift'
}
export const routingInfo = country => ROUTING[String(country || '').toUpperCase()] || null

// First problem with a bank submission, as a plain sentence, or '' when it looks right.
export function bankProblem({ bankCountry, routingCode, accountNumber, swiftBic }) {
  const c = String(bankCountry || '').toUpperCase()
  if (swiftBic && !validSwiftBic(swiftBic)) return 'Enter the SWIFT/BIC as 8 or 11 letters and digits, e.g. CHASUS33.'
  if (!c) return ''
  const rail = bankRail(c, accountNumber)
  if (rail === 'iban') {
    if (!validIban(accountNumber)) return 'That IBAN doesn\u2019t look right. Check it and enter it in full, e.g. DE89 3704 0044 0532 0130 00.'
    if (String(accountNumber).replace(/\s+/g, '').slice(0, 2).toUpperCase() !== c) return 'The IBAN must start with the country the account is held in.'
    return ''
  }
  if (rail === 'routing') {
    const r = ROUTING[c]
    if (!routingCode) return `Enter your ${r.label.toLowerCase()} (${r.hint}).`
    if (!r.test(routingCode)) return `That ${r.label.toLowerCase()} doesn\u2019t look right \u2014 it should be ${r.hint}.`
    if (!DOMESTIC_ACCOUNT[c].test(digitsOnly(accountNumber))) return 'That account number doesn\u2019t look right for the country you chose \u2014 digits only.'
    return ''
  }
  return swiftBic ? '' : 'Enter your bank\u2019s SWIFT/BIC code \u2014 international transfers need it.'
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
