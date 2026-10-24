// The job description is the other half of a scan, and the half that cannot be got back: a posting is pasted
// from a tab the person has since closed, or typed as a link they had to hunt for. A scan that failed (a dropped
// connection, the daily limit, a 5 MB upload that timed out) used to keep the typed background (brainDumpDraft.js)
// but lose the job, so the person came back to a form that wanted the posting again.
//
// Same rules as the background draft: kept in this browser only, owned by whoever was signed in when it was typed
// (a draft typed signed out is available to whoever signs in next), dropped when a scan is sent or the person signs
// out, and every storage call is guarded because storage can be missing, full or blocked.
const KEY = 'passthrough_scan_jd_draft'
// Well above the 5,000-character limit the scorer fits a posting to, so a long paste still comes back whole.
const MAX_STORED = 20000

function readRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null')
    return raw && typeof raw === 'object' ? raw : null
  } catch (_) { return null }
}
const ownerOf = raw => (raw && typeof raw.owner === 'string' && raw.owner ? raw.owner : null)

export function loadJdDraft(viewerId = null) {
  const raw = readRaw()
  if (!raw) return null
  const owner = ownerOf(raw)
  if (owner && owner !== viewerId) return null
  const text = typeof raw.text === 'string' ? raw.text : ''
  const url = typeof raw.url === 'string' ? raw.url : ''
  if (!text.trim() && !url.trim()) return null
  return { text, url, useUrl: raw.useUrl === true }
}

export function saveJdDraft({ text = '', url = '', useUrl = false, owner = null }) {
  try {
    if (!text.trim() && !url.trim()) { localStorage.removeItem(KEY); return }
    localStorage.setItem(KEY, JSON.stringify({
      text: text.slice(0, MAX_STORED), url: url.slice(0, 2048), useUrl: !!useUrl, ...(owner ? { owner } : {}),
    }))
  } catch (_) { /* storage unavailable or full: the form still works, it just cannot remember */ }
}

export function clearJdDraft() {
  try { localStorage.removeItem(KEY) } catch (_) {}
}

// Called when a session is adopted: a draft that belongs to someone else is removed rather than left in storage unseen.
export function dropForeignJdDraft(userId) {
  const owner = ownerOf(readRaw())
  if (owner && owner !== userId) clearJdDraft()
}
