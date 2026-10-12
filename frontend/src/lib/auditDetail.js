// How an audit entry's `detail` reads on the audit-log screen. Round 12 (Section 5): the screen interpolated each
// value into a template string, so every lead export showed "filters: [object Object]" (even for no filters at all)
// and a filter-wide bulk action printed a couple of thousand ids on one line. Detail never carries personal data
// (see src/lib/adminAudit.js) — only ids, counts, field names and transitions — so this is formatting only.
const SHOWN_IDS = 3

function formatValue(v) {
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (Array.isArray(v)) {
    if (v.length === 0) return null
    const simple = v.every(x => x === null || ['string', 'number', 'boolean'].includes(typeof x))
    if (!simple) return `${v.length} items`
    return v.length <= SHOWN_IDS ? v.join(', ') : `${v.slice(0, SHOWN_IDS).join(', ')} … (${v.length} in all)`
  }
  if (v && typeof v === 'object') {
    const inner = Object.entries(v).map(([k, x]) => [k, formatValue(x)]).filter(([, x]) => x !== null && x !== '')
    return inner.length ? inner.map(([k, x]) => `${k} ${x}`).join(', ') : null   // {} says nothing: drop it
  }
  if (v === undefined || v === null || v === '') return null
  return String(v)
}

// -> [string]  one "key: value" per entry worth showing
export function auditDetailParts(detail) {
  return Object.entries(detail || {})
    .map(([k, v]) => [k, formatValue(v)])
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}: ${v}`)
}
