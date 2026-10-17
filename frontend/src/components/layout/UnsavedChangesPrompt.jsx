import { useEffect, useRef, useState } from 'react'
import ConfirmDialog from '../ui/ConfirmDialog'
import { setDiscardPrompt } from '../../lib/unsavedGuard'

// FEATURE GAP CLOSED (Shared frontend, G1): "you have unsaved changes — leave?" (leaving the page, signing out) was asked with the
// browser's native window.confirm(). A browser can suppress those for a page, and a suppressed one answers "cancel" with nothing
// shown, which left a person holding a draft unable to leave or sign out and never told why. This asks in the app's own dialog
// (focus trap, Escape, "Stay" focused so a stray Enter cannot discard anything). Mounted once, in the app shell; it registers
// itself with lib/unsavedGuard (askDiscardUnsaved) and unregisters on unmount, which answers an open question as "stay".
export default function UnsavedChangesPrompt() {
  const [ask, setAsk] = useState(null)   // { message, confirmLabel, cancelLabel } while a question is open
  const entry = useRef(null)

  useEffect(() => {
    setDiscardPrompt(opts => new Promise(resolve => { entry.current = { resolve }; setAsk(opts || {}) }))
    return () => {
      setDiscardPrompt(null)
      entry.current?.resolve(false)
      entry.current = null
    }
  }, [])

  function answer(ok) {
    const e = entry.current
    entry.current = null
    setAsk(null)
    e?.resolve(ok)
  }

  return (
    <ConfirmDialog
      open={!!ask}
      title="Unsaved changes"
      message={ask?.message}
      confirmLabel={ask?.confirmLabel || 'Leave'}
      cancelLabel={ask?.cancelLabel || 'Stay'}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
  )
}
