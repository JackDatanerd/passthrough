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

// ── The question as a dialog ─────────────────────────────────────────────────────────────────────────
// SHARED FRONTEND (feature gap): both questions above went through the browser's native window.confirm(). A browser can switch
// those off for a page ("Prevent this page from creating additional dialogs", or an embedded webview that never shows them), and
// a suppressed confirm() answers "cancel" without showing anything — so someone holding an unsaved draft could neither leave the
// page nor sign out, with no explanation. <UnsavedChangesPrompt> (layout) registers a host here and the question is asked in the
// app's own, accessible dialog instead. With no host registered (a unit test, a bare render) the native confirm is the fallback.
//
// askDiscardUnsaved() -> Promise<boolean>, same meaning as confirmDiscardUnsaved(): true = go ahead, false = they chose to stay.
// Several callers asking at once (every dirty editor on a page runs its own blocker for the same navigation) share ONE dialog.
let discardHost = null
let discardPending = null

// `fn({ message, confirmLabel, cancelLabel })` -> Promise<boolean>. Pass null to unregister.
export function setDiscardPrompt(fn) { discardHost = typeof fn === 'function' ? fn : null }

// `force`: ask even when no editor has registered itself yet (the route blocker only fires for a dirty editor, so it always asks).
export function askDiscardUnsaved(message = LEAVE_MESSAGE, { confirmLabel, cancelLabel, force = false } = {}) {
  if (!force && !hasUnsavedWork()) return Promise.resolve(true)
  if (!discardHost) {
    if (!force) return Promise.resolve(confirmDiscardUnsaved(message))
    // The native fallback behaves exactly as the route blocker's own confirm always did (it does not open the "already agreed" window).
    const stay = typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(message)
    return Promise.resolve(!stay)
  }
  if (!discardPending) {
    discardPending = Promise.resolve()
      .then(() => discardHost({ message, confirmLabel, cancelLabel }))
      .then(ok => { if (ok) allowNextLeave(); return !!ok }, () => false)   // a host that failed answers "stay": nothing is discarded by accident
      .finally(() => { discardPending = null })
  }
  return discardPending
}

// For tests.
export function resetLeaveGuard() { leaveAllowedUntil = 0; discardHost = null; discardPending = null }
