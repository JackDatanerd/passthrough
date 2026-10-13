import useOnlineStatus from '../../hooks/useOnlineStatus'

// FEATURE GAP CLOSED (Shared frontend round 9): a phone that loses signal mid-upload or mid-edit just saw each request
// fail with "Can't reach the server", with nothing saying the whole device was offline. This says so once, at the top of
// the page, and goes away by itself when the connection returns.
export default function OfflineBanner() {
  const online = useOnlineStatus()
  if (online) return null
  return (
    <div role="status" className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-center text-sm text-amber-900">
      You're offline. Anything you save or upload will fail until your connection is back.
    </div>
  )
}
