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

export const LEAVE_MESSAGE = 'You have unsaved changes. Leave this page and discard them?'
export const SIGN_OUT_MESSAGE = 'You have unsaved changes. Sign out and discard them?'

// SHARED FRONTEND (section 11, bug): Navbar, DashboardLayout and Settings' account deletion each did `logout(); navigate('/')`.
// logout() wipes the token, the cached user, the brain-dump draft and the unclaimed anonymous-scan tokens at once; only
// THEN did navigate('/') reach the editor's route blocker and ask "discard unsaved changes?". Answering "Stay" left the
// person on the page — already signed out, draft gone, every later save a 401 (the resume prompt cannot help: the request
// carries no token). The question now comes FIRST (confirmDiscardUnsaved) and, once it is answered yes, the blocker is told
// not to ask the same question again for the navigation that follows.
//
// The answer is good for a short window rather than for one check: several dirty editors on a page each run their own
// blocker for the same navigation, and a one-shot flag would let only the first of them through.
const LEAVE_ALLOWED_MS = 1500
let leaveAllowedUntil = 0

// The person has already agreed to leave (or leaving is not up to them — the account was just deleted): the navigation that
// is about to start must not be blocked by an unsaved-changes guard.
export function allowNextLeave() { leaveAllowedUntil = Date.now() + LEAVE_ALLOWED_MS }
export function leaveAllowed() { return Date.now() < leaveAllowedUntil }

// true = go ahead (nothing unsaved, or the person agreed to discard it); false = they chose to stay.
export function confirmDiscardUnsaved(message = LEAVE_MESSAGE) {
  if (!hasUnsavedWork()) return true
  if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)) return false
  allowNextLeave()
  return true
}

// For tests.
export function resetLeaveGuard() { leaveAllowedUntil = 0 }
