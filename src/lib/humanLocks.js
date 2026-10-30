'use strict'

// Experts Phase 1: locking a client's structured resume before an expert sees it, and restoring it after.
//
//   lockDocument(resumeData, shared?, opts?) -> { body, locked }   body = the resume with every contact value and third-party detail replaced by a
//                                                   marker; locked = { <path|inline id>: <the real value> } (stored sealed, server side)
//   restoreDocument(body, locked, opts?) -> { data, missing }
//   validateEdit(base, next)  -> { ok, errors[] }   what the SERVER accepts from the editor (the browser is never the lock)
//   maskingContext / redactText / redactDeep        scrub free text (a brief, an answer, a revision note) the same way, for what an expert reads
//
// Locked outright (replaced by [[lock:<path>]]): name, email, phone, location, linkedin, portfolio, every project link, and any
// references/referees block. Read-only but visible (company, title, dates, school, degree...): the experience, education and
// volunteer anchors, so the work cannot drift from what the client did. Contact details typed INSIDE text (an email, a phone number,
// a web address, a street address, the client's own name, any value the resume itself holds as a contact detail) are lifted to [[c:N]]
// markers. Everything else is the expert's to rewrite.
//
// A5 audit round 1: name matching is Unicode-aware and case-aware (an accented or non-Latin name is lifted; a surname that is also a word,
// "Baker", is not lifted from the lower-case word "baker"); the client's OWN contact values are scrubbed wherever they appear (G1); every
// contact pattern is linear time (a crafted 60,000-character upload used to cost seconds of CPU); the draft's contact values win over the
// source's (an owner's edit in the editor used to be thrown away at delivery); built-in object keys cannot be used to bypass the section check.

const TOP_LOCKED = ['name', 'email', 'phone', 'location', 'linkedin', 'portfolio']
const REF_KEYS = ['references', 'referees', 'reference']
const EDITABLE_TOP = ['summary', 'skills', 'certifications', 'awards', 'languages', 'publications']
const FROZEN_ENTRY = { experience: ['company', 'title', 'dates', 'location'], education: ['institution', 'degree', 'dates'], volunteer: ['organization', 'role', 'dates'] }
const MARKER = /\[\[(lock:[A-Za-z0-9_.]+|c:\d+)\]\]/g
const MAX_JSON = 100000
const MAX_DEPTH = 12
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// ---- contact patterns. Each one is anchored so that a long run of look-alike characters is tried from its START only (linear time). ----
const EMAIL = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi
const OBF_EMAIL_A = /(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+\s*[([]\s*at\s*[)\]]\s*[A-Z0-9-]+(?:\s*[([]\s*dot\s*[)\]]\s*[A-Z0-9-]+)+/gi
const OBF_EMAIL_B = /(?<![A-Z0-9._%+-])[A-Z0-9_%+-]+(?:\s+dot\s+[A-Z0-9_%+-]+)*\s+at\s+[A-Z0-9-]+(?:\s+dot\s+[A-Z0-9-]+)+/gi
const TLD = '(?:(?:co|com|org|ac|gov|edu|net)\\.[a-z]{2}|com|org|net|co|app|me|dev|ai|us|uk|ke|ng|za|in|de|fr|io|xyz|tech|site|online|info|biz|edu|gov|ca|au|nl|es|se|ch|tz|ug|rw|gh|pk|br|mx|jp|cn|sg|ae|page|link|store|shop|design|studio|work|pro|cv|gg|tv)'
const URL_RE = new RegExp(String.raw`\b(?:https?:\/\/|www\.)[^\s)>\]]+|(?<![\w@.-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.${TLD}\b(?:\/[^\s)>\]]*)?`, 'gi')
const NOT_A_DOMAIN = /^(?:asp|vb)\.net$|^socket\.io$/i
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{6,30}\d(?![\w])/g
const CTX_PHONE = /\b(?:tel|telephone|phone|mobile|cell|call|whatsapp|contact)\b\.?\s*(?:no\.?|number|#)?\s*[:\-–]?\s*(\+?\d[\d\s().-]{4,26}\d)(?![\w])/gi
const HANDLE = /\b(?:twitter|instagram|telegram|tiktok|snapchat|whatsapp|skype|github|gitlab)\s*(?::|-|–)\s*@?[A-Za-z0-9_.]{2,30}|\b(?:twitter|instagram|telegram|tiktok|snapchat)\s+@[A-Za-z0-9_.]{2,30}/gi
const ADDRESS = /\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][\p{L}.'’-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Way|Court|Ct|Close|Crescent|Place|Pl|Highway|Hwy|Terrace|Estate)\b\.?/gu
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+(?:[-\s]\d+)?/gi
const digits = s => (s.match(/\d/g) || []).length
function isPhone(s) {
  const t = s.trim(); const n = digits(t)
  if (n < 9 || n > 15) return false
  const groups = t.split(/\D+/).filter(Boolean)
  if (/^\d{4}\s*[-–]\s*\d{4}$/.test(t)) return false
  if (groups.length >= 2 && groups.every(g => g.length === 4 && +g >= 1900 && +g <= 2100)) return false                       // "2019 2020 2021"
  if (!/^[+(]/.test(t) && groups.length >= 4 && /^\d{1,3}$/.test(groups[0]) && groups.slice(1).every(g => g.length === 3) && /^[\d ]+$/.test(t)) return false   // "1 234 567 890"
  return true
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const B_L = '(?<![\\p{L}\\p{N}_])', B_R = '(?![\\p{L}\\p{N}_])'

// The client's name: the whole name in either order, then each part. A part is matched with the capitalisation it was written with (or
// all capitals, or Title case), so "Baker" is lifted but the word "baker" is not. Boundaries are Unicode letters, not ASCII \w.
function nameMatchers(name) {
  const parts = String(name || '').split(/\s+/).map(s => s.replace(/[^\p{L}'’-]/gu, '')).filter(Boolean)
  const out = []
  if (parts.length >= 2) {
    out.push(new RegExp(`${B_L}${parts.map(escapeRe).join('[\\s,.]+')}${B_R}`, 'giu'))
    out.push(new RegExp(`${B_L}${[...parts].reverse().map(escapeRe).join('[\\s,.]+')}${B_R}`, 'giu'))
  }
  for (const p of new Set(parts)) {
    if (p.length < 3) continue
    const forms = [...new Set([p, p.toUpperCase(), p[0].toUpperCase() + p.slice(1).toLowerCase()])]
    out.push(new RegExp(`${B_L}(?:${forms.map(escapeRe).join('|')})${B_R}`, 'gu'))
  }
  return out
}

// Values the resume itself holds as contact details (the sealed lock map), turned into matchers that find them anywhere in free text.
function knownMatchers(values) {
  const out = []; const seen = new Set()
  for (const raw of values) {
    const v = String(raw || '').trim(); if (v.length < 3 || seen.has(v)) continue
    seen.add(v)
    if (digits(v) >= 7 && digits(v) <= 15 && /^[+\d\s().-]+$/.test(v)) {
      const ds = v.replace(/\D/g, '')
      out.push(new RegExp(`(?<!\\d)\\+?${ds.split('').join('[\\s().-]*')}(?!\\d)`, 'g'))
      if (ds.length >= 10) out.push(new RegExp(`(?<!\\d)0[\\s().-]*${ds.slice(-9).split('').join('[\\s().-]*')}(?!\\d)`, 'g'))
      continue
    }
    const variants = [v]; const bare = v.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/+$/, '')
    if (bare !== v && bare.length >= 4) variants.push(bare)
    for (const x of variants) out.push(new RegExp(`${B_L}${escapeRe(x).replace(/\s*,\s*/g, '\\s*,\\s*').replace(/\s+/g, '\\s+')}${B_R}`, 'giu'))
  }
  return out
}
function knownStrings(locked) {
  const out = []
  for (const [k, v] of Object.entries(locked || {})) {
    if (!k.startsWith('lock:') || typeof v !== 'string') continue
    if (REF_KEYS.includes(k.slice(5))) {
      try { const walkRef = x => { if (typeof x === 'string') return; if (Array.isArray(x)) x.forEach(walkRef); else if (x && typeof x === 'object') for (const [rk, rv] of Object.entries(x)) { if (typeof rv === 'string' && /name|email|phone|mobile|tel|contact/i.test(rk) && rv.trim().length >= 4) out.push(rv); else walkRef(rv) } }; walkRef(JSON.parse(v)) } catch { /* not JSON: nothing to add */ }
    } else out.push(v)
  }
  return out
}
function maskingContext(locked, extraNames = []) {
  const names = [...extraNames, locked && locked['lock:name']].filter(Boolean)
  return { names: names.flatMap(nameMatchers), known: knownMatchers(knownStrings(locked)) }
}

// every contact-looking span in a string, outside any marker, as [{start,end,text}] (overlaps merged, longest wins)
function contactSpans(str, opts = {}) {
  const spans = []
  const masked = str.replace(MARKER, m => ' '.repeat(m.length))
  const addOn = (re, ok) => { for (const m of masked.matchAll(re)) if (!ok || ok(m[0])) spans.push({ start: m.index, end: m.index + m[0].length }) }
  addOn(EMAIL); addOn(OBF_EMAIL_A); addOn(OBF_EMAIL_B); addOn(URL_RE, s => !NOT_A_DOMAIN.test(s)); addOn(PHONE, isPhone); addOn(ADDRESS); addOn(PO_BOX); addOn(HANDLE)
  for (const m of masked.matchAll(CTX_PHONE)) { const d = digits(m[1]); if (d >= 6 && d <= 15) { const start = m.index + m[0].lastIndexOf(m[1]); spans.push({ start, end: start + m[1].length }) } }
  for (const re of opts.known || []) addOn(re)
  for (const re of opts.names || []) addOn(re)
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const out = []
  for (const sp of spans) { const last = out[out.length - 1]; if (last && sp.start < last.end) { if (sp.end > last.end) last.end = sp.end } else out.push({ ...sp }) }
  return out.map(sp => ({ ...sp, text: str.slice(sp.start, sp.end) }))
}
const hasContact = (str, opts) => typeof str === 'string' && contactSpans(str, opts).length > 0

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const clone = v => JSON.parse(JSON.stringify(v))

// `shared` ({ locked, n }) lets several documents of ONE job (the source, the AI draft, a cover letter) be locked into a single
// map: inline ids never collide. A top-level field (the email, say) keeps the value it first had, EXCEPT for the document the expert
// works from: lock it with { override: true } and its values replace the earlier ones (the customer's own edits are what ships).
function lockDocument(resumeData, shared = null, opts = {}) {
  const rd = clone(resumeData || {})
  const locked = shared ? shared.locked : {}
  let n = shared ? shared.n : 0
  const setLocked = (k, v) => { if (opts.override || !hasOwn(locked, k)) locked[k] = v }
  const ownName = rd.name
  for (const k of TOP_LOCKED) { if (typeof rd[k] === 'string' && rd[k].trim()) { setLocked(`lock:${k}`, rd[k]); rd[k] = `[[lock:${k}]]` } }
  if (Array.isArray(rd.projects)) rd.projects.forEach((p, i) => { if (p && typeof p.link === 'string' && p.link.trim()) { setLocked(`lock:projects.${i}.link`, p.link); p.link = `[[lock:projects.${i}.link]]` } })
  for (const k of REF_KEYS) if (rd[k] != null && rd[k] !== '' && !(Array.isArray(rd[k]) && !rd[k].length)) { setLocked(`lock:${k}`, JSON.stringify(rd[k])); rd[k] = `[[lock:${k}]]` }
  const ctx = maskingContext(locked, [typeof ownName === 'string' ? ownName : ''])
  const liftText = str => {
    const spans = contactSpans(str, ctx); if (!spans.length) return str
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

// Free text an expert will READ that never went through lockDocument (the brief, an answer, a revision note): same engine, the span is
// replaced by a plain token rather than a marker, because nothing is ever restored into it.
function redactText(text, ctx, token = '[removed]') {
  const s = String(text == null ? '' : text); if (!s) return s
  const spans = contactSpans(s, ctx || {}); if (!spans.length) return s
  let out = '', at = 0
  for (const sp of spans) { out += s.slice(at, sp.start) + token; at = sp.end }
  return out + s.slice(at)
}
function redactDeep(v, ctx, depth = 0) {
  if (typeof v === 'string') return redactText(v, ctx)
  if (depth > MAX_DEPTH) return v
  if (Array.isArray(v)) return v.map(x => redactDeep(x, ctx, depth + 1))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, ctx, depth + 1)]))
  return v
}

// requireAll: true (a whole resume) also reports a locked top-level field whose marker is gone; false (a cover letter, which only
// mentions some of them) reports only a marker the text uses that has no stored value. `required` (the lock markers the document the
// expert STARTED from carried) replaces "every locked key": a field the customer's draft never had cannot be missing from the result.
function restoreDocument(body, locked, { requireAll = true, required = null } = {}) {
  const missing = new Set(); const seen = new Set()
  const sub = str => str.replace(MARKER, (m, key) => { if (hasOwn(locked, key)) { seen.add(key); return locked[key] } missing.add(key); return m })
  const walk = v => typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
  const data = walk(clone(body))
  for (const k of REF_KEYS) if (typeof data[k] === 'string' && locked[`lock:${k}`] === undefined) delete data[k]
  for (const k of REF_KEYS) if (locked[`lock:${k}`] !== undefined && seen.has(`lock:${k}`)) { try { data[k] = JSON.parse(locked[`lock:${k}`]) } catch { /* keep text */ } }
  if (required) { for (const k of required) if (k.startsWith('lock:') && !seen.has(k)) missing.add(k) }
  else if (requireAll) for (const k of Object.keys(locked)) if (k.startsWith('lock:') && !seen.has(k)) missing.add(k)
  return { data, missing: [...missing].sort() }
}

function markerCounts(v, acc = Object.create(null)) {
  if (typeof v === 'string') { for (const m of v.matchAll(MARKER)) acc[m[1]] = (acc[m[1]] || 0) + 1 }
  else if (Array.isArray(v)) v.forEach(x => markerCounts(x, acc))
  else if (isObj(v)) Object.values(v).forEach(x => markerCounts(x, acc))
  return acc
}
function leaves(v, path = '', out = Object.create(null)) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) out[path] = v
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, path ? `${path}.${i}` : String(i), out))
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out)
  return out
}
const isFrozenPath = p => { const m = /^(experience|education|volunteer)\.\d+\.(\w+)$/.exec(p); return !!m && FROZEN_ENTRY[m[1]].includes(m[2]) }
const isLockedPath = (p, base) => TOP_LOCKED.includes(p) || /^projects\.\d+\.link$/.test(p) || REF_KEYS.includes(p) || (hasOwn(base, p) && typeof base[p] === 'string' && /^\[\[lock:/.test(base[p]))

// nesting deeper than any real resume, or an own "__proto__" key anywhere (JSON.parse creates one; leaf paths cannot represent it)
function shapeProblem(v) {
  const stack = [[v, 0]]
  while (stack.length) {
    const [x, d] = stack.pop()
    if (x && typeof x === 'object') {
      if (d > MAX_DEPTH) return 'TOO_DEEP'
      if (!Array.isArray(x) && hasOwn(x, '__proto__')) return 'RESERVED_KEY'
      for (const y of Array.isArray(x) ? x : Object.values(x)) stack.push([y, d + 1])
    }
  }
  return null
}

function validateEdit(base, next) {
  const errors = []; const err = (path, code) => errors.push({ path, code })
  if (!isObj(next)) return { ok: false, errors: [{ path: '', code: 'NOT_AN_OBJECT' }] }
  if (JSON.stringify(next).length > MAX_JSON) return { ok: false, errors: [{ path: '', code: 'TOO_LARGE' }] }
  const shape = shapeProblem(next); if (shape) return { ok: false, errors: [{ path: '', code: shape }] }
  const b = leaves(base), x = leaves(next)
  for (const [p, v] of Object.entries(x)) { if (typeof v !== 'string' && v != null && v !== b[p]) err(p, 'NOT_TEXT') }
  for (const key of ['experience', 'education', 'volunteer', 'projects']) {
    if ((Array.isArray(base[key]) ? base[key].length : 0) !== (Array.isArray(next[key]) ? next[key].length : 0)) err(key, 'ENTRY_COUNT_CHANGED')
  }
  for (const k of Object.keys(next)) if (!hasOwn(base, k) && !EDITABLE_TOP.includes(k)) err(k, 'SECTION_NOT_ALLOWED')
  for (const k of Object.keys(base)) if (!hasOwn(next, k) && (TOP_LOCKED.includes(k) || REF_KEYS.includes(k))) err(k, 'LOCKED_FIELD_REMOVED')
  for (const [p, v] of Object.entries(b)) {
    if ((isFrozenPath(p) || isLockedPath(p, base) || /^projects\.\d+\.link$/.test(p)) && x[p] !== v) err(p, isFrozenPath(p) ? 'READ_ONLY_CHANGED' : 'LOCKED_FIELD_CHANGED')
  }
  const bc = markerCounts(base), nc = markerCounts(next)
  for (const [m, c] of Object.entries(nc)) { if (!hasOwn(bc, m)) err(m, 'UNKNOWN_MARKER'); else if (c > bc[m]) err(m, 'MARKER_DUPLICATED') }
  for (const [m] of Object.entries(bc)) if (m.startsWith('lock:') && !hasOwn(nc, m)) err(m, 'LOCKED_FIELD_REMOVED')
  // a contact detail typed into text. Only text the expert CHANGED is judged: a line they did not touch came from the baseline.
  for (const [p, v] of Object.entries(x)) { if (typeof v === 'string' && v !== b[p] && hasContact(v)) err(p, 'CONTACT_IN_TEXT') }
  const seen = new Set(); const uniq = errors.filter(e => { const k = e.path + '|' + e.code; if (seen.has(k)) return false; seen.add(k); return true })
  return { ok: uniq.length === 0, errors: uniq }
}

// every leaf path of a (masked) document the expert may NOT change: locked contact fields and the read-only anchors
function readOnlyPaths(base) { return Object.keys(leaves(base)).filter(p => isFrozenPath(p) || isLockedPath(p, base)) }

module.exports = { readOnlyPaths, lockText, MARKER, TOP_LOCKED, EDITABLE_TOP, FROZEN_ENTRY, lockDocument, restoreDocument, validateEdit, contactSpans, hasContact, leaves, markerCounts,
  maskingContext, redactText, redactDeep, nameMatchers, knownMatchers }
