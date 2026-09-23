import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { useToast } from '../../components/ui/Toast'
import { formatDate, formatCents } from '../../lib/utils'

const PAGE_SIZE = 25
// SECTION 8 AUDIT: REFUNDED/DISPUTED added (migration 0023) — payments in
// either state used to be indistinguishable from SUCCESS in this list.
const STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REFUNDED', 'DISPUTED']

export default function AdminPayments() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const [payments, setPayments] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyRef, setBusyRef] = useState(null)
  const [pendingAction, setPendingAction] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/admin/payments', { params: { page, pageSize: PAGE_SIZE, status: status || undefined } })
      setPayments(res.data.data)
      setTotal(res.data.meta.total)
    } catch (_) {
      toast({ message: 'Failed to load payments.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [page, status])

  useEffect(() => { load() }, [load])

  function setStatus(next) {
    setPage(1)
    setSearchParams(next ? { status: next } : {})
  }

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

  async function confirmPendingAction() {
    const action = pendingAction
    if (action.type === 'reconcile') return runReconcile(action.payment)
    if (action.type === 'recheck') return runRecheck(action.payment)
    if (action.type === 'recheck-mismatch') return runRecheck(action.payment, true)
    if (action.type === 'resolve') return runResolvePayment(action.payment, action.action)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const badgeVariant = s => ({ SUCCESS: 'green', PENDING: 'amber', FAILED: 'red', ABANDONED: 'gray', REFUNDED: 'gray', DISPUTED: 'red' }[s] || 'gray')

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-gray-900">Payments</h1>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">Status</label>
        <select value={status} onChange={e => setStatus(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm w-56">
          <option value="">All</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
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
        <p className="text-sm text-gray-500">No payments found.</p>
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
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.paystackRef}</td>
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
                    {p.status === 'DISPUTED' && p.disputedAt && (
                      <div className="text-xs text-gray-400 mt-0.5">{formatDate(p.disputedAt)}</div>
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
