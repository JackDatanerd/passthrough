// A tiny registry of "this tab holds work the person has typed and not saved yet". useUnsavedChangesWarning()
// registers while its editor is dirty; lib/api.js asks it before it hard-redirects an ended session away, so a
// session that ends mid-edit can be re-opened in place (see SessionResumePrompt) instead of discarding the draft.
let count = 0

// -> a function that unregisters (idempotent).
export function markUnsaved() {
  count++
  let released = false
  return () => { if (!released) { released = true; count = Math.max(0, count - 1) } }
}

export function hasUnsavedWork() { return count > 0 }
