import useOnlineStatus from '../../hooks/useOnlineStatus'

// FEATURE GAP CLOSED (Shared frontend round 9): a phone that loses signal mid-upload or mid-edit just saw each request
// fail with "Can't reach the server", with nothing saying the whole device was offline. This says so once, at the top of
// the page, and goes away by itself when the connection returns.
// The live region itself is ALWAYS in the page and only its content comes and goes: a role="status" node that is inserted already
// holding its text is often not announced at all (screen readers watch a region for changes, they do not read one that arrives), so
// the one message people most need when a save is about to fail was silent for them.
export default function OfflineBanner() {
  const online = useOnlineStatus()
  return (
    <div role="status">
      {!online && (
        <div className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-center text-sm text-amber-900">
          You're offline. Anything you save or upload will fail until your connection is back.
        </div>
      )}
    </div>
  )
}
