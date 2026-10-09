import { useEffect } from 'react'

// Asks the browser to confirm before the page is closed, reloaded or navigated away from by URL while
// `dirty` is true. Several editors hold long, hand-typed drafts (the saved profile, a scan's resume
// data, a PAID delivered resume) and an accidental refresh or closed tab used to drop all of it
// silently; only SavedProfileEditor was protected, by its own inline copy of this listener.
//
// Scope, deliberately: this covers leaving the PAGE (close / reload / typed URL / external link). The
// app uses <BrowserRouter>, which has no navigation blocker (useBlocker needs a data router), so
// in-app link clicks are not intercepted — editors cover their own Cancel button with a ConfirmDialog.
export function useUnsavedChangesWarning(dirty) {
  useEffect(() => {
    if (!dirty) return undefined
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

export default useUnsavedChangesWarning
