// The three Passthrough marks a look-4 resume can carry (backend: services/design.service.js normalizeMarks, migration 0124).
// A missing or partial value means "on": a mark is only ever off because the owner turned it off.
export const MARK_KEYS = ['header', 'colophon', 'footer']

export function normalizeMarks(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  const out = {}
  for (const k of MARK_KEYS) out[k] = o[k] !== false
  return out
}

export const marksEqual = (a, b) => MARK_KEYS.every(k => normalizeMarks(a)[k] === normalizeMarks(b)[k])

// The three boxes' wording. `verified` is whether the scan clears the Verified bar: below it the same marks say "Scan report", never "Verified".
export function markOptions(verified) {
  const name = verified ? 'Verified' : 'Scan report'
  return [
    { key: 'header',   label: `${name} badge in the header`,
      description: 'Top of page 1, beside your name. In your Word file it is the credential line under your contact details.' },
    { key: 'colophon', label: 'Proof block on the last page',
      description: 'A QR code and one sentence at the foot of the last page, so a printed copy can be checked. Dropped automatically if the page is too full for it.' },
    { key: 'footer',   label: 'Verification code in the page footer',
      description: 'Printed from page 2 onward, so a loose page still points back to the proof. A one-page resume has no footer.' },
  ]
}
