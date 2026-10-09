import { useEffect, useId, useRef, useState } from 'react'
import Modal from './Modal'
import Button from './Button'
import Alert from './Alert'
import { getErrorMessage } from '../../lib/errors'

// FEATURE GAP CLOSED (audit): destructive/impactful admin actions (ban a
// user, delete a lead, invalidate a partner's payout link, reverse a
// payment, reconcile/recheck a payment) all used the browser's native
// window.confirm() — unstyled, blocks the JS thread, no keyboard/focus
// handling beyond whatever the browser itself provides, untestable — while
// this app already has a fully accessible Modal (focus trap, Esc, dismissible-
// while-busy) that was only ever wired up for one destructive flow (account
// deletion in Settings.jsx). This wraps that same Modal for the "are you
// sure?" case so every destructive action gets the same treatment, not just
// the one that happened to get built carefully.
//
// window.confirm() is synchronous — the calling code just does
// `if (!window.confirm(msg)) return; ...`. A Modal isn't, so callers hold
// one small piece of state (what's pending) instead:
//
//   const [confirming, setConfirming] = useState(null)   // { message, onConfirm } | null
//
//   async function removeLead(lead) {
//     setConfirming({
//       message: `Delete the lead from ${lead.email}? This can't be undone.`,
//       onConfirm: async () => { await api.delete(`/leads/${lead.id}`); load() }
//     })
//   }
//   ...
//   <ConfirmDialog
//     open={!!confirming}
//     message={confirming?.message}
//     onConfirm={async () => { await confirming.onConfirm(); setConfirming(null) }}
//     onCancel={() => setConfirming(null)}
//   />
//
// The dialog also guards itself: while an async `onConfirm` is running it ignores further clicks (a
// double-click used to fire the action twice when the caller hadn't wired `loading`) and shows the
// busy state on its own; if `onConfirm` REJECTS, the error is shown inside the dialog (which stays
// open for a retry) instead of surfacing as an unhandled rejection. Callers that already catch their
// own errors and manage `loading` are unaffected.
export default function ConfirmDialog({
  open, title = 'Are you sure?', message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = true, loading = false, onConfirm, onCancel, children
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const messageId = useId()

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  // A fresh opening starts clean.
  useEffect(() => { if (open) setError('') }, [open])

  async function handleConfirm() {
    if (busyRef.current || loading) return
    busyRef.current = true
    setBusy(true); setError('')
    try {
      await onConfirm?.()
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, "That didn't go through. Please try again."))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const working = loading || busy
  return (
    <Modal open={open} onClose={onCancel} title={title} dismissible={!working} describedBy={messageId}>
      <p id={messageId} className="text-sm text-gray-600 whitespace-pre-line">{message}</p>
      {/* Optional extra controls (a "also block this address" checkbox, say) between the message and the buttons. */}
      {children && <div className="mt-4">{children}</div>}
      {error && <Alert variant="error" className="mt-4">{error}</Alert>}
      <div className="mt-5 flex justify-end gap-2">
        {/* Initial focus: Cancel for a destructive action (a stray Enter must not
            confirm it), Confirm otherwise. Without this it landed on the header's X. */}
        <Button variant="secondary" size="sm" onClick={() => onCancel?.()} disabled={working} data-autofocus={danger ? true : undefined}>{cancelLabel}</Button>
        <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={handleConfirm} loading={working} data-autofocus={danger ? undefined : true}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}
