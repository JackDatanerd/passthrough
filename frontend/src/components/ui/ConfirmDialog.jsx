import Modal from './Modal'
import Button from './Button'

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
export default function ConfirmDialog({
  open, title = 'Are you sure?', message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = true, loading = false, onConfirm, onCancel
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} dismissible={!loading}>
      <p className="text-sm text-gray-600 whitespace-pre-line">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>{cancelLabel}</Button>
        <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}
