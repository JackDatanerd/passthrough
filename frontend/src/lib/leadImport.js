// Parsing for the employer-lead CSV import (AdminLeads → "Import CSV"). Kept free of React so it can be
// tested on its own. No dependency: the format needed here (RFC 4180 quoting, a header row, a comma,
// semicolon or tab delimiter, a UTF-8 byte-order mark from Excel) is small.

export const IMPORT_BATCH_SIZE = 200
export const IMPORT_MAX_ROWS = 5000

// Which header names mean which lead field. Matching ignores case, spaces, hyphens and underscores.
const ALIASES = {
  name:    ['name', 'fullname', 'contact', 'contactname'],
  company: ['company', 'organisation', 'organization', 'employer', 'companyname'],
  email:   ['email', 'emailaddress', 'mail'],
  field:   ['field', 'rolecategory', 'category', 'function'],
  role:    ['role', 'roletitle', 'title', 'jobtitle', 'position'],
  notes:   ['notes', 'note', 'comment', 'comments'],
}
const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function parseCsv(input) {
  let text = String(input || '').replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const delimiter = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]
  const rows = []
  let row = [], cell = '', quoted = false
  const endCell = () => { row.push(cell); cell = '' }
  const endRow = () => { endCell(); if (row.some(c => c.trim() !== '')) rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false }
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) endCell()
    else if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow() }
    else if (ch === '\n') endRow()
    else cell += ch
  }
  if (cell !== '' || row.length) endRow()
  return rows
}

// -> { rows: [{ name, company, email, field, role, notes }], error: string|null }
export function leadRowsFromCsv(input) {
  const table = parseCsv(input)
  if (table.length < 2) return { rows: [], error: 'The file needs a header row and at least one lead.' }
  const header = table[0].map(norm)
  const col = {}
  for (const [key, names] of Object.entries(ALIASES)) col[key] = header.findIndex(h => names.includes(h))
  const missing = ['name', 'company', 'email'].filter(k => col[k] < 0)
  if (missing.length) return { rows: [], error: `Add a column for: ${missing.join(', ')}. Optional columns: field, role, notes.` }
  const rows = table.slice(1).map(r => {
    const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '')
    return { name: get('name'), company: get('company'), email: get('email'), field: get('field'), role: get('role'), notes: get('notes') }
  })
  if (rows.length > IMPORT_MAX_ROWS) return { rows: [], error: `At most ${IMPORT_MAX_ROWS} leads per file; this one has ${rows.length}.` }
  return { rows, error: null }
}

export const chunk = (arr, size = IMPORT_BATCH_SIZE) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
