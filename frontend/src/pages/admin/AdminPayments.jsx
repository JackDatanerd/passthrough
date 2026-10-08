import { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import Select from '../../components/ui/Select'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Modal from '../../components/ui/Modal'
import Input from '../../components/ui/Input'
import { useToast } from '../../components/ui/Toast'
import { formatDate, formatCents } from '../../lib/utils'
import usePageClamp from '../../hooks/usePageClamp'
import EmptyState from '../../components/ui/EmptyState'

const PAGE_SIZE = 25
// SECTION 8 AUDIT: REFUNDED/DISPUTED added (migration 0023) — payments in
// either state used to be indistinguishable from SUCCESS in this list.
const STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REFUNDED', 'DISPUTED']

export default function AdminPayments() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  // ROUND 5 (feature gap): a payment could only be found by paging; the Webhooks page also links here by reference.
  const referenceQ = searchParams.get('reference') || ''
  const [refDraft, setRefDraft] = useState(referenceQ)
  useEffect(() => { setRefDraft(referenceQ) }, [referenceQ])
  const [payments, setPayments] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyRef, setBusyRef] = useState(null)
  const [pendingAction, setPendingAction] = useState(null)
  const [refundDialog, setRefundDialog] = useState(null)   // { payment, amount, note, error } | null
  const [refunding, setRefunding] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/payments', { params: { page, pageSize: PAGE_SIZE, status: status || undefined, reference: referenceQ || undefined } })
      setPayments(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load payments.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status, referenceQ])

  useEffect(() => { load() }, [load])

  function applyFilters(next = {}) {
    const merged = { status, reference: referenceQ, ...next }
    const params = {}
    for (const [k, v] of Object.entries(merged)) if (v) params[k] = v
    setPage(1)
    setSearchParams(params)
  }
  const setStatus = next => applyFilters({ status: next })

  // BUG FIX (audit, feature gap): reconcile/recheck/resolvePayment all used
  // `window.confirm()` — see components/ui/ConfirmDialog.jsx. recheck's
  // follow-up (the amount-mismatch "accept and settle anyway?" case) used to
  // be a second, nested window.confirm() inside the first's catch block;
  // that's now its own pendingAction type ('recheck-mismatch') rather than a
  // second native dialog stacked on the first. Each of the four click
  // handlers below now just opens the dialog with what it needs to run;
  // confirmPendingAction (below the last one) dispatches to the matching
  // run* function, and each run* function is responsible for its own
  // pendingAction lifecycle — closing it on success/hard-failure, or (only
  // recheck) transitioning it to the mismatch follow-up instead of closing.
  function reconcile(payment) {
    setPendingAction({
      type: 'reconcile', payment,
      confirmMsg: `Reconcile ${payment.paystackRef}? This re-attempts fix delivery and the partner-commission ` +
        `write for this payment. Safe to run even if it already succeeded — it's a no-op in that case.`,
      danger: false
    })
  }

  async function runReconcile(payment) {
    setBusyRef(payment.paystackRef)
    try {
      const res = await api.post(`/payments/${payment.paystackRef}/reconcile`)
      toast({ message: res.data.message || 'Reconciled.', type: res.data.success ? 'success' : 'error' })
      load()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to reconcile payment.'), type: 'error' })
    } finally {
      setBusyRef(null)
    }
    setPendingAction(null)
  }

  // SECTION 8 AUDIT (feature gap): a payment held for an amount mismatch, or
  // one whose webhook was lost, sat PENDING/ABANDONED/FAILED with no action
  // here — /reconcile only accepts SUCCESS. This asks Paystack directly and
  // settles it if the money really arrived.
  function recheck(payment) {
    setPendingAction({
      type: 'recheck', payment,
      confirmMsg: `Ask Paystack whether ${payment.paystackRef} was actually paid, and settle it if so?`,
      danger: false
    })
  }

  async function runRecheck(payment, acceptAmountMismatch = false) {
    setBusyRef(payment.paystackRef)
    try {
      const res = await api.post(`/payments/${payment.paystackRef}/recheck`, { acceptAmountMismatch })
      toast({ message: res.data.message || 'Checked.', type: res.data.success ? 'success' : 'error' })
      load()
      setPendingAction(null)
    } catch (err) {
      const data = err.response?.data
      // A held amount mismatch (409) offers a follow-up: accept the amount difference explicitly.
      if (!acceptAmountMismatch && err.response?.status === 409 && data?.data?.outcome === 'MISMATCH' && data.data.expectedCurrency === data.data.receivedCurrency) {
        setPendingAction({
          type: 'recheck-mismatch', payment,
          confirmMsg: `${data.message}\n\nExpected ${data.data.expectedAmount}, received ${data.data.receivedAmount} (same currency). Accept and settle anyway?`,
          danger: true
        })
      } else {
        toast({ message: getErrorMessage(err, 'Failed to check payment.'), type: 'error' })
        setPendingAction(null)
      }
    } finally {
      setBusyRef(null)
    }
  }

  // SECTION 8 AUDIT: refunds/disputes now have real states to move between —
  // reverse (refund the sale / lost dispute) and clear-dispute (won it).
  function resolvePayment(payment, action) {
    const confirmMsg = action === 'reverse'
      ? `Reverse ${payment.paystackRef}? This marks it REFUNDED, reverses any partner commission, and revokes the public verification page. This cannot be undone from here.`
      : `Clear the dispute on ${payment.paystackRef} and mark it SUCCESS again?`
    setPendingAction({ type: 'resolve', payment, action, confirmMsg, danger: action === 'reverse' })
  }

  async function runResolvePayment(payment, action) {
    setBusyRef(payment.paystackRef)
    try {
      const res = await api.post(`/payments/${payment.paystackRef}/resolve`, { action })
      toast({ message: res.data.message || 'Done.', type: res.data.success ? 'success' : 'error' })
      load()
    } catch (err) {
      toast({ message: getErrorMessage(err, 'Failed to update payment.'), type: 'error' })
    } finally {
      setBusyRef(null)
    }
    setPendingAction(null)
  }

  // FEATURE GAP CLOSED (Payments & Pricing round 2 — G2): POST
  // /payments/:reference/refund (queues a real Paystack refund; full by default,
  // partial with an amount) was built, tested and routed — and had no button.
  // Every "refund needed" owner alert (DUPLICATE, SCAN_MISSING, ACCOUNT_DELETED)
  // therefore still ended in "go refund it in the Paystack dashboard by hand".
  // This only QUEUES the refund; our row flips to REFUNDED via Paystack's
  // refund.processed webhook (see refundPayment's own comment), so the list is
  // reloaded but the status is not expected to change immediately.
  const isRefundable = p =>
    p.status === 'SUCCESS' && p.amountCents > 0 && !String(p.paystackRef || '').startsWith('credit:')

  function openRefund(payment) {
    setRefundDialog({ payment, amount: '', note: '', error: '' })
  }

  async function runRefund() {
    const { payment, amount, note } = refundDialog
    let amountCents
    if (amount.trim() !== '') {
      const major = Number(amount)
      amountCents = Math.round(major * 100)
      if (!Number.isFinite(major) || major <= 0 || !Number.isInteger(amountCents) || amountCents <= 0) {
        setRefundDialog(d => ({ ...d, error: 'Enter a positive amount, or leave it blank for a full refund.' })); return
      }
      if (amountCents > payment.amountCents) {
        setRefundDialog(d => ({ ...d, error: `That is more than the ${formatCents(payment.amountCents, payment.currency)} paid.` })); return
      }
    }
    setRefunding(true)
    setBusyRef(payment.paystackRef)
    try {
      const res = await api.post(`/payments/${encodeURIComponent(payment.paystackRef)}/refund`, {
        amountCents, note: note.trim() || undefined,
      })
      toast({ message: res.data.message || 'Refund queued.', type: 'success' })
      setRefundDialog(null)
      load()
    } catch (err) {
      // Keep the dialog open with the server's reason (open refund in flight,
      // Paystack rejected it, …) so the admin can adjust instead of retyping.
      setRefundDialog(d => d && ({ ...d, error: getErrorMessage(err, 'Failed to queue the refund.') }))
    } finally {
      setRefunding(false)
      setBusyRef(null)
    }
  }

  async function confirmPendingAction() {
    const action = pendingAction
    if (action.type === 'reconcile') return runReconcile(action.payment)
    if (action.type === 'recheck') return runRecheck(action.payment)
    if (action.type === 'recheck-mismatch') return runRecheck(action.payment, true)
    if (action.type === 'resolve') return runResolvePayment(action.payment, action.action)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })
  const badgeVariant = s => ({ SUCCESS: 'green', PENDING: 'amber', FAILED: 'red', ABANDONED: 'gray', REFUNDED: 'gray', DISPUTED: 'red' }[s] || 'gray')

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Payments</h1>

      <div className="flex flex-wrap items-end gap-4">
        <Select label="Status" value={status} onChange={e => setStatus(e.target.value)} wrapperClassName="w-56">
          <option value="">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
        <form className="flex items-end gap-3" onSubmit={e => { e.preventDefault(); applyFilters({ reference: refDraft.trim() }) }}>
          <Input id="pay-ref" label="Payment reference" value={refDraft} onChange={e => setRefDraft(e.target.value)}
            placeholder="contains…" wrapperClassName="w-56" className="font-mono" />
          <Button type="submit" size="sm" variant="secondary">Search</Button>
        </form>
      </div>

      {status === 'PENDING' && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          A payment stuck PENDING usually means an amount mismatch was caught and held for manual review
          (see the owner alert sent at the time) — check Paystack's dashboard for the matching reference before touching anything here.
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : payments.length === 0 ? (
        <EmptyState>No payments found.</EmptyState>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Tier</th>
                <th className="px-4 py-3">Referral</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {payments.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {p.paystackRef}
                    {!String(p.paystackRef).startsWith('credit:') && (
                      <div><Link to={`/admin/webhooks?reference=${encodeURIComponent(p.paystackRef)}`} className="font-sans text-blue-700 hover:underline">Webhook events</Link></div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.userEmail || '—'}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatCents(p.amountCents, p.currency)}</td>
                  <td className="px-4 py-3">
                    <Badge variant={badgeVariant(p.status)}>{p.status}</Badge>
                    {/* AUDIT FIX (Section 9/10 pass): refunded_at/refund_reference/disputed_at
                        (migrations 0024/0025) were captured by the webhook handler but never
                        shown here — a REFUNDED or DISPUTED row gave no way to see when it
                        happened or what the refund reference was. */}
                    {p.status === 'REFUNDED' && p.refundedAt && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        {formatDate(p.refundedAt)}{p.refundReference ? ` · ${p.refundReference}` : ''}
                      </div>
                    )}
                    {/* ROUND 5: money confirmed back by Paystack on a payment that stays SUCCESS (a partial refund). */}
                    {p.status === 'SUCCESS' && p.refundedCents > 0 && (
                      <div className="text-xs text-amber-700 mt-0.5">
                        Partially refunded {formatCents(p.refundedCents, p.currency)} of {formatCents(p.amountCents, p.currency)}
                      </div>
                    )}
                    {p.status === 'DISPUTED' && p.disputedAt && (
                      <div className="text-xs text-gray-400 mt-0.5">{formatDate(p.disputedAt)}</div>
                    )}
                    {/* AUDIT FIX (Section 9/10 pass): receipt_sent_at/receipt_delivered_at
                        (migrations 0033/0036) were captured by fulfillment.service.js but never
                        surfaced anywhere admin could see — no way to answer a "I paid but never
                        got a receipt" ticket without querying the DB directly. receiptDeliveredAt
                        is the one that means the email genuinely went out; receiptSentAt alone
                        (claimed before sending) with no deliveredAt means the send was claimed but
                        never confirmed finished — a real, actionable warning, since that column
                        only exists on the new tracked code path.
                        Deliberately NOT a warning when BOTH are null: sendReceiptOnce's own
                        comment confirms receipt-sending predates this tracking (0033 added
                        idempotency to an already-live send, not the send itself) — a payment from
                        before that migration shipped correctly has both columns null even though
                        its receipt really did go out via the old, untracked path. Flagging that as
                        "No receipt sent" would be a false alarm on every pre-migration row, not a
                        real signal. Shown as neutral, not amber, for that reason. Only shown for
                        SUCCESS payments — a REFUNDED/DISPUTED row's own line above already covers
                        what matters for it. */}
                    {p.status === 'SUCCESS' && (
                      p.receiptDeliveredAt ? (
                        <div className="text-xs text-gray-400 mt-0.5">Receipt sent {formatDate(p.receiptDeliveredAt)}</div>
                      ) : p.receiptSentAt ? (
                        <div className="text-xs text-amber-600 mt-0.5">Receipt send unconfirmed ({formatDate(p.receiptSentAt)})</div>
                      ) : (
                        <div className="text-xs text-gray-400 mt-0.5">Receipt not tracked</div>
                      )
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{p.fixTier || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.referralCode || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                    {p.status === 'SUCCESS' && (
                      <>
                        <Button size="sm" variant="secondary" disabled={busyRef === p.paystackRef}
                          onClick={() => reconcile(p)}>
                          Reconcile
                        </Button>
                        {isRefundable(p) && (
                          <Button size="sm" variant="secondary" disabled={busyRef === p.paystackRef}
                            onClick={() => openRefund(p)}>
                            Refund
                          </Button>
                        )}
                        <Button size="sm" variant="danger" disabled={busyRef === p.paystackRef}
                          onClick={() => resolvePayment(p, 'reverse')}>
                          Reverse
                        </Button>
                      </>
                    )}
                    {['PENDING', 'ABANDONED', 'FAILED'].includes(p.status) && (
                      <Button size="sm" variant="secondary" disabled={busyRef === p.paystackRef}
                        onClick={() => recheck(p)}>
                        Recheck
                      </Button>
                    )}
                    {p.status === 'DISPUTED' && (
                      <>
                        <Button size="sm" variant="secondary" disabled={busyRef === p.paystackRef}
                          onClick={() => resolvePayment(p, 'clear-dispute')}>
                          Clear dispute
                        </Button>
                        <Button size="sm" variant="danger" disabled={busyRef === p.paystackRef}
                          onClick={() => resolvePayment(p, 'reverse')}>
                          Reverse
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onChange={p => setPage(p)} />
      )}

      <Modal open={!!refundDialog} onClose={() => setRefundDialog(null)} title="Refund via Paystack" dismissible={!refunding}>
        {refundDialog && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              Queues a refund for <span className="font-mono text-xs">{refundDialog.payment.paystackRef}</span>{' '}
              ({formatCents(refundDialog.payment.amountCents, refundDialog.payment.currency)} paid). Paystack processes it
              asynchronously; the payment is marked REFUNDED (commission reversed, credential revoked) once Paystack confirms a full refund.
            </p>
            <Input
              label="Amount (leave blank for a full refund)"
              type="number" step="0.01" min="0" inputMode="decimal"
              value={refundDialog.amount}
              onChange={e => setRefundDialog(d => ({ ...d, amount: e.target.value, error: '' }))}
              placeholder={(refundDialog.payment.amountCents / 100).toFixed(2)}
              disabled={refunding}
            />
            <Input
              label="Note for the Paystack record (optional)"
              maxLength={200}
              value={refundDialog.note}
              onChange={e => setRefundDialog(d => ({ ...d, note: e.target.value }))}
              disabled={refunding}
            />
            {refundDialog.error && <p role="alert" className="text-sm text-red-600">{refundDialog.error}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setRefundDialog(null)} disabled={refunding}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={runRefund} loading={refunding}>Queue refund</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!pendingAction}
        title="Confirm"
        message={pendingAction?.confirmMsg}
        danger={pendingAction?.danger ?? true}
        loading={busyRef === pendingAction?.payment.paystackRef}
        onConfirm={confirmPendingAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  )
}
