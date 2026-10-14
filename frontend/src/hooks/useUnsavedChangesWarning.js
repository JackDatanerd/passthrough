import { useContext, useEffect } from 'react'
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom'
import { markUnsaved, leaveAllowed, LEAVE_MESSAGE } from '../lib/unsavedGuard'

// Two protections while `dirty` is true, for the editors that hold long hand-typed drafts (the saved
// profile, a scan's resume data, a PAID delivered resume):
//   1. the browser's own prompt before the page is closed, reloaded or left by URL (`beforeunload`);
//   2. a confirm before any IN-APP navigation to another page — a link click, the nav tabs, the Back /
//      Forward buttons. The app runs on a data router (App.jsx) precisely so useBlocker is available.
// Moving within the same page (query string / hash changes) is never blocked. Cancel / Save buttons
// inside an editor keep their own ConfirmDialog; they never navigate.
//
// A component rendered outside a data router (a bare <MemoryRouter> in a unit test) gets only (1).
// Whether a data router exists never changes during a component's life, so the conditional hook call
// below always runs the same hooks in the same order.
function useRouteBlocker(dirty) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    // leaveAllowed(): the person already answered "discard?" for this very navigation (sign out asks before it clears the
    // session — see confirmDiscardUnsaved), so asking again would be a second prompt, or a "Stay" after the damage is done.
    dirty && !leaveAllowed() && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    if (window.confirm(LEAVE_MESSAGE)) blocker.proceed()
    else blocker.reset()
  }, [blocker])
}

function useNoRouteBlocker() {}

export function useUnsavedChangesWarning(dirty) {
  const hasDataRouter = useContext(UNSAFE_DataRouterContext) != null
  // eslint-disable-next-line react-hooks/rules-of-hooks
  ;(hasDataRouter ? useRouteBlocker : useNoRouteBlocker)(dirty)

  // Tells lib/api.js this tab holds unsaved work, so an ended session can be resumed in place rather than redirected away.
  useEffect(() => (dirty ? markUnsaved() : undefined), [dirty])

  useEffect(() => {
    if (!dirty) return undefined
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

export default useUnsavedChangesWarning
