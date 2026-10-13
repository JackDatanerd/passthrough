// A typed background is the one input in the app that can't be recreated from a file: a failed or
// abandoned attempt used to throw away up to 12,000 characters the person had just written. The
// draft is kept in this browser until a result exists, then dropped. Storage can be missing, full
// or blocked — every call is guarded and the form works without it.
const KEY = 'passthrough_brain_dump_draft'

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

export function loadBrainDumpDraft(viewerId = null) {
  try {
    const raw = readRaw()
    if (!raw) return null
    const owner = ownerOf(raw)
    if (owner && owner !== viewerId) return null
    return {
      text:  typeof raw.text === 'string' ? raw.text : '',
      name:  typeof raw.name === 'string' ? raw.name : '',
      email: typeof raw.email === 'string' ? raw.email : '',
    }
  } catch (_) { return null }
}

export function saveBrainDumpDraft({ text = '', name = '', email = '', owner = null }) {
  try {
    if (!text.trim() && !name.trim() && !email.trim()) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(owner ? { text, name, email, owner } : { text, name, email }))
  } catch (_) { /* storage unavailable/full — the form still works, it just can't remember */ }
}

// Called when a session is adopted: a draft that belongs to someone else is removed outright rather than
// left in storage unseen.
export function dropForeignBrainDumpDraft(userId) {
  try {
    const owner = ownerOf(readRaw())
    if (owner && owner !== userId) localStorage.removeItem(KEY)
  } catch (_) {}
}

export function clearBrainDumpDraft() {
  try { localStorage.removeItem(KEY) } catch (_) {}
}
