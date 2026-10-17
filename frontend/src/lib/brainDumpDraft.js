// A typed background is the one input in the app that can't be recreated from a file: a failed or
// abandoned attempt used to throw away up to 12,000 characters the person had just written. The
// draft is kept in this browser until a result exists, then dropped. Storage can be missing, full
// or blocked — every call is guarded and the form works without it.
//
// RESUME-FROM-SCRATCH ROUND 2: the structured "Fill it in myself" form is the same kind of input (a whole
// work history typed by hand, nowhere else to get it back from) and was never kept, so a reload, a closed
// tab or a failed scan lost it. It rides in the same draft as `manual`.
import { manualHasContent } from './resumeForm'

const KEY = 'passthrough_brain_dump_draft'
// Which scan a draft produced, and what the draft held when it was sent. See clearDraftIfSubmitted.
const SENT_KEY = 'passthrough_brain_dump_draft_sent'

// A draft written while signed in carries its author's id and is only ever shown to that person: a session
// can end without a sign-out (expiry, a password change elsewhere, a ban), and the next person to use this
// browser must not find the last one's resume text, name and email in the form. A draft typed signed out has
// no owner and is available to whoever signs in next, as before.
function readRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    return raw && typeof raw === 'object' ? raw : null
  } catch (_) { return null }
}
const ownerOf = raw => (raw && typeof raw.owner === 'string' && raw.owner ? raw.owner : null)

// The structured form as stored: only a plain object that actually carries content is a draft.
const manualOf = raw => (raw && raw.manual && typeof raw.manual === 'object' && !Array.isArray(raw.manual) && manualHasContent(raw.manual) ? raw.manual : null)

export function loadBrainDumpDraft(viewerId = null) {
  try {
    const raw = readRaw()
    if (!raw) return null
    const owner = ownerOf(raw)
    if (owner && owner !== viewerId) return null
    const manual = manualOf(raw)
    return {
      text:  typeof raw.text === 'string' ? raw.text : '',
      name:  typeof raw.name === 'string' ? raw.name : '',
      email: typeof raw.email === 'string' ? raw.email : '',
      ...(manual ? { manual } : {}),
    }
  } catch (_) { return null }
}

export function saveBrainDumpDraft({ text = '', name = '', email = '', manual = null, owner = null }) {
  try {
    const keptManual = manual && manualHasContent(manual) ? manual : null
    if (!text.trim() && !name.trim() && !email.trim() && !keptManual) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify({ text, name, email, ...(keptManual ? { manual: keptManual } : {}), ...(owner ? { owner } : {}) }))
  } catch (_) { /* storage unavailable/full — the form still works, it just can't remember */ }
}

// Called when a session is adopted: a draft that belongs to someone else is removed outright rather than
// left in storage unseen.
export function dropForeignBrainDumpDraft(userId) {
  try {
    const owner = ownerOf(readRaw())
    if (owner && owner !== userId) clearBrainDumpDraft()
  } catch (_) {}
}

export function clearBrainDumpDraft() {
  try { localStorage.removeItem(KEY) } catch (_) {}
  try { localStorage.removeItem(SENT_KEY) } catch (_) {}
}

// ── "Done with this draft" is a fact about ONE scan ─────────────────────────────────────────────────
// The result page used to clear the draft whenever ANY from-scratch result was open. Opening an old result (from the
// history list, an e-mail, another tab) while a NEW background was half typed silently deleted the new text. The form
// now notes which scan it sent and what that part of the draft held; only that scan's result clears it, and only if the
// person has not typed something different since.
const partOf = (raw, mode) => (mode === 'manual' ? { manual: manualOf(raw) } : { text: raw.text || '', name: raw.name || '', email: raw.email || '' })
// djb2 — a cheap fingerprint to compare two versions of the same draft, not a security hash.
function fingerprint(part) {
  const s = JSON.stringify(part)
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return `${s.length}:${h}`
}

// mode: 'text' (the brain-dump box and its contact fields) or 'manual' (the structured form).
export function markDraftSent(scanId, mode = 'text') {
  try {
    const raw = readRaw()
    if (!raw || !scanId) return
    localStorage.setItem(SENT_KEY, JSON.stringify({ scanId, mode, fp: fingerprint(partOf(raw, mode)) }))
  } catch (_) {}
}

// Returns true when it removed (part of) the draft.
export function clearDraftIfSent(scanId) {
  try {
    const sent = JSON.parse(localStorage.getItem(SENT_KEY) || 'null')
    if (!sent || sent.scanId !== scanId) return false
    localStorage.removeItem(SENT_KEY)
    const raw = readRaw()
    if (!raw || fingerprint(partOf(raw, sent.mode)) !== sent.fp) return false
    const rest = { ...raw }
    if (sent.mode === 'manual') delete rest.manual
    else { rest.text = ''; rest.name = ''; rest.email = '' }
    const keepsManual = !!manualOf(rest)
    if (!String(rest.text || '').trim() && !String(rest.name || '').trim() && !String(rest.email || '').trim() && !keepsManual) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(rest))
    return true
  } catch (_) { return false }
}
