'use strict'

// Experts Phase 1: locking a client's structured resume before an expert sees it, and restoring it after.
//
//   lockDocument(resumeData)  -> { body, locked }   body = the resume with every contact value and third-party detail replaced by a
//                                                   marker; locked = { <path|inline id>: <the real value> } (stored sealed, server side)
//   restoreDocument(body, locked) -> { data, missing }
//   validateEdit(base, next)  -> { ok, errors[] }   what the SERVER accepts from the editor (the browser is never the lock)
//
// Locked outright (replaced by [[lock:<path>]]): name, email, phone, location, linkedin, portfolio, every project link, and any
// references/referees block. Read-only but visible (company, title, dates, school, degree...): the experience, education and
// volunteer anchors, so the work cannot drift from what the client did. Contact details typed INSIDE text (an email, a phone number,
// a web address, the client's own name) are lifted to [[c:N]] markers. Everything else is the expert's to rewrite.

const TOP_LOCKED = ['name', 'email', 'phone', 'location', 'linkedin', 'portfolio']
const REF_KEYS = ['references', 'referees', 'reference']
const EDITABLE_TOP = ['summary', 'skills', 'certifications', 'awards', 'languages', 'publications']
const FROZEN_ENTRY = { experience: ['company', 'title', 'dates', 'location'], education: ['institution', 'degree', 'dates'], volunteer: ['organization', 'role', 'dates'] }
const MARKER = /\[\[(lock:[A-Za-z0-9_.]+|c:\d+)\]\]/g
const MAX_JSON = 100000

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s)>\]]+|\b[a-z0-9][a-z0-9-]*\.(?:com|org|net|co|app|me|dev|ai|us|uk|ke|ng|za|in|de|fr)\b(?:\/[^\s)>\]]*)?/gi
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w])/g
const digits = s => (s.match(/\d/g) || []).length
const isPhone = s => { const n = digits(s); return n >= 9 && n <= 15 && !/^\d{4}\s*[-–]\s*\d{4}$/.test(s.trim()) }

// every contact-looking span in a string, outside any marker, as [{start,end,text}] (overlaps merged, longest wins)
function contactSpans(str, nameParts = []) {
  const spans = []
  const add = (re, ok) => { for (const m of str.matchAll(re)) if (!ok || ok(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] }) }
  const masked = str.replace(MARKER, m => ' '.repeat(m.length))
  const s = masked
  const addOn = (re, ok) => { for (const m of s.matchAll(re)) if (!ok || ok(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, text: str.slice(m.index, m.index + m[0].length) }) }
  addOn(EMAIL); addOn(URL_RE); addOn(PHONE, isPhone)
  for (const p of nameParts) addOn(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'))
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out = []
  for (const sp of spans) { const last = out[out.length - 1]; if (last && sp.start < last.end) { if (sp.end > last.end) { last.end = sp.end; last.text = str.slice(last.start, last.end) } } else out.push({ ...sp }) }
  return out
}
const hasContact = str => typeof str === 'string' && contactSpans(str).length > 0

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const clone = v => JSON.parse(JSON.stringify(v))

function nameParts(name) { return String(name || '').split(/\s+/).map(s => s.replace(/[^\p{L}'-]/gu, '')).filter(s => s.length >= 3) }

// `shared` ({ locked, n }) lets several documents of ONE job (the source, the AI draft, a cover letter) be locked into a single
// map: inline ids never collide, and a top-level field (the email, say) keeps the value it first had.
function lockDocument(resumeData, shared = null) {
  const rd = clone(resumeData || {})
  const locked = shared ? shared.locked : {}
  let n = shared ? shared.n : 0
  const setLocked = (k, v) => { if (!Object.prototype.hasOwnProperty.call(locked, k)) locked[k] = v }
  const parts = nameParts(rd.name)
  for (const k of TOP_LOCKED) { if (typeof rd[k] === 'string' && rd[k].trim()) { setLocked(`lock:${k}`, rd[k]); rd[k] = `[[lock:${k}]]` } }
  if (Array.isArray(rd.projects)) rd.projects.forEach((p, i) => { if (p && typeof p.link === 'string' && p.link.trim()) { setLocked(`lock:projects.${i}.link`, p.link); p.link = `[[lock:projects.${i}.link]]` } })
  for (const k of REF_KEYS) if (rd[k] != null && rd[k] !== '' && !(Array.isArray(rd[k]) && !rd[k].length)) { setLocked(`lock:${k}`, JSON.stringify(rd[k])); rd[k] = `[[lock:${k}]]` }
  const liftText = str => {
    const spans = contactSpans(str, parts); if (!spans.length) return str
    let out = '', at = 0
    for (const sp of spans) { n += 1; locked[`c:${n}`] = sp.text; out += str.slice(at, sp.start) + `[[c:${n}]]`; at = sp.end }
    return out + str.slice(at)
  }
  const walk = v => {
    if (typeof v === 'string') return /^\[\[lock:[\w.]+\]\]$/.test(v) ? v : liftText(v)
    if (Array.isArray(v)) return v.map(walk)
    if (isObj(v)) { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v }
    return v
  }
  const body = walk(rd)
  if (shared) shared.n = n
  return { body, locked }
}

// A cover letter is plain text: same lifting of contact details and the client's own name.
function lockText(text, shared, name) {
  const holder = { name: name || '' }
  const { body } = lockDocument({ name: holder.name, summary: String(text || '') }, shared)
  return body.summary
}

// requireAll: true (a whole resume) also reports a locked top-level field whose marker is gone; false (a cover letter, which only
// mentions some of them) reports only a marker the text uses that has no stored value.
function restoreDocument(body, locked, { requireAll = true } = {}) {
  const missing = new Set(); const seen = new Set()
  const sub = str => str.replace(MARKER, (m, key) => { if (Object.prototype.hasOwnProperty.call(locked, key)) { seen.add(key); return locked[key] } missing.add(key); return m })
  const walk = v => typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
  const data = walk(clone(body))
  for (const k of REF_KEYS) if (typeof data[k] === 'string' && locked[`lock:${k}`] === undefined) delete data[k]
  for (const k of REF_KEYS) if (locked[`lock:${k}`] !== undefined && seen.has(`lock:${k}`)) { try { data[k] = JSON.parse(locked[`lock:${k}`]) } catch { /* keep text */ } }
  if (requireAll) for (const k of Object.keys(locked)) if (k.startsWith('lock:') && !seen.has(k)) missing.add(k)
  return { data, missing: [...missing].sort() }
}

function markerCounts(v, acc = {}) {
  if (typeof v === 'string') { for (const m of v.matchAll(MARKER)) acc[m[1]] = (acc[m[1]] || 0) + 1 }
  else if (Array.isArray(v)) v.forEach(x => markerCounts(x, acc))
  else if (isObj(v)) Object.values(v).forEach(x => markerCounts(x, acc))
  return acc
}
function leaves(v, path = '', out = {}) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) out[path] = v
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, path ? `${path}.${i}` : String(i), out))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out)
  return out
}
const isFrozenPath = p => { const m = /^(experience|education|volunteer)\.\d+\.(\w+)$/.exec(p); return !!m && FROZEN_ENTRY[m[1]].includes(m[2]) }
const isLockedPath = (p, base) => TOP_LOCKED.includes(p) || /^projects\.\d+\.link$/.test(p) || REF_KEYS.includes(p) || (typeof base[p] === 'string' && /^\[\[lock:/.test(base[p]))

function validateEdit(base, next) {
  const errors = []; const err = (path, code) => errors.push({ path, code })
  if (!isObj(next)) return { ok: false, errors: [{ path: '', code: 'NOT_AN_OBJECT' }] }
  if (JSON.stringify(next).length > MAX_JSON) return { ok: false, errors: [{ path: '', code: 'TOO_LARGE' }] }
  const b = leaves(base), x = leaves(next)
  for (const [p, v] of Object.entries(x)) { if (typeof v !== 'string' && v != null) err(p, 'NOT_TEXT') }
  for (const key of ['experience', 'education', 'volunteer', 'projects']) {
    if ((Array.isArray(base[key]) ? base[key].length : 0) !== (Array.isArray(next[key]) ? next[key].length : 0)) err(key, 'ENTRY_COUNT_CHANGED')
  }
  for (const k of Object.keys(next)) if (!(k in base) && !EDITABLE_TOP.includes(k)) err(k, 'SECTION_NOT_ALLOWED')
  for (const k of Object.keys(base)) if (!(k in next) && (TOP_LOCKED.includes(k) || REF_KEYS.includes(k))) err(k, 'LOCKED_FIELD_REMOVED')
  for (const [p, v] of Object.entries(b)) {
    if ((isFrozenPath(p) || isLockedPath(p, base) || /^projects\.\d+\.link$/.test(p)) && x[p] !== v) err(p, isFrozenPath(p) ? 'READ_ONLY_CHANGED' : 'LOCKED_FIELD_CHANGED')
  }
  const bc = markerCounts(base), nc = markerCounts(next)
  for (const [m, c] of Object.entries(nc)) { if (!(m in bc)) err(m, 'UNKNOWN_MARKER'); else if (c > bc[m]) err(m, 'MARKER_DUPLICATED') }
  for (const [m] of Object.entries(bc)) if (m.startsWith('lock:') && !(m in nc)) err(m, 'LOCKED_FIELD_REMOVED')
  for (const [p, v] of Object.entries(x)) { if (typeof v === 'string' && hasContact(v)) err(p, 'CONTACT_IN_TEXT') }
  const seen = new Set(); const uniq = errors.filter(e => { const k = e.path + '|' + e.code; if (seen.has(k)) return false; seen.add(k); return true })
  return { ok: uniq.length === 0, errors: uniq }
}

// every leaf path of a (masked) document the expert may NOT change: locked contact fields and the read-only anchors
function readOnlyPaths(base) { return Object.keys(leaves(base)).filter(p => isFrozenPath(p) || isLockedPath(p, base)) }

module.exports = { readOnlyPaths, lockText, MARKER, TOP_LOCKED, EDITABLE_TOP, FROZEN_ENTRY, lockDocument, restoreDocument, validateEdit, contactSpans, hasContact, leaves, markerCounts }
