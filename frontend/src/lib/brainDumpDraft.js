// A typed background is the one input in the app that can't be recreated from a file: a failed or
// abandoned attempt used to throw away up to 12,000 characters the person had just written. The
// draft is kept in this browser until a result exists, then dropped. Storage can be missing, full
// or blocked — every call is guarded and the form works without it.
const KEY = 'passthrough_brain_dump_draft'

export function loadBrainDumpDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (!raw || typeof raw !== 'object') return null
    return {
      text:  typeof raw.text === 'string' ? raw.text : '',
      name:  typeof raw.name === 'string' ? raw.name : '',
      email: typeof raw.email === 'string' ? raw.email : '',
    }
  } catch (_) { return null }
}

export function saveBrainDumpDraft({ text = '', name = '', email = '' }) {
  try {
    if (!text.trim() && !name.trim() && !email.trim()) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify({ text, name, email }))
  } catch (_) { /* storage unavailable/full — the form still works, it just can't remember */ }
}

export function clearBrainDumpDraft() {
  try { localStorage.removeItem(KEY) } catch (_) {}
}
