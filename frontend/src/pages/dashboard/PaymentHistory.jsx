import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Button from '../../components/ui/Button'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { formatDate, formatCents } from '../../lib/utils'
import Checkbox from '../../components/ui/Checkbox'
import useLatestRequest from '../../hooks/useLatestRequest'

// FEATURE GAP CLOSED (Payments & Pricing re-audit): GET /api/payments/history
// (payments.controller.js's getPaymentHistory) has existed, fully built and
// tested, since Section 9 — id/amountCents/currency/status/paystackRef/
// createdAt/scanId/fixTier per payment — but nothing in the frontend ever
// called it. A paying customer had no in-app way to see what they'd bought,
// when, or for how much; the only record was the email receipt. This is that
// missing consumer: a plain read-only list, reusing the same status-badge and
// currency-formatting conventions AdminPayments.jsx already established.

// Mirrors AdminPayments.jsx's badgeVariant — same six pay_status_enum values
// (see migrations 0001/0024), just without the admin-only actions column.
const STATUS_VARIANT = { SUCCESS: 'green', PENDING: 'amber', FAILED: 'red', ABANDONED: 'gray', REFUNDED: 'gray', DISPUTED: 'red' }

const TIER_LABEL = { FIX: 'Fix + Credential', BADGE: 'Credential only', FIX_PLAIN: 'Fix only' }

// A free-credit redemption is recorded as a real $0 SUCCESS payment row
// (see scan.controller.js's redeemCredit — "same shape as a real
// transaction, just free"), identifiable by its paystack_ref prefix
// (payments.controller.js's own recheckPayment checks the same prefix).
// Surfacing that distinction here rather than just showing "$0" avoids it
// reading like a pricing glitch.
function isFreeCredit(payment) {
  return (payment.paystackRef || '').startsWith('credit:')
}

// Matches payments.controller.js's getPaymentHistory default; sent explicitly so
// the page and the server can never disagree about what "a page" is.
const PAGE_SIZE = 20

export default function PaymentHistory() {
  const [payments, setPayments] = useState([])
  const [total, setTotal]       = useState(0)
  const [page, setPage]         = useState(1)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  // AUDIT FIX (Payments & Pricing round 2, feature gap — G3): the backend has
  // supported ?includeAbandoned=1 since the history endpoint was paginated;
  // nothing offered it. Unfinished checkouts stay hidden by default (they were
  // burying real purchases) but are one tick away for a customer who needs to
  // find one.
  const [showAbandoned, setShowAbandoned] = useState(false)
  // Per-row receipt/cancel state, keyed by paystackRef: { busy, note, noteTone }.
  const [rowState, setRowState] = useState({})
  const [confirmCancel, setConfirmCancel] = useState(null)   // payment | null
  const [cancelling, setCancelling] = useState(false)

  const patchRow = (ref, patch) => setRowState(prev => ({ ...prev, [ref]: { ...prev[ref], ...patch } }))

  // AUDIT FIX (Payments & Pricing round 2, bug — B1): this used to call
  // /payments/history with no page and keep only `payments`. Since the endpoint
  // was paginated (default 20) every account with more than 20 visible payments
  // silently lost its older purchases from view — `total` was returned and
  // discarded. Now requests an explicit page and renders Pagination.
  const begin = useLatestRequest()
  const load = useCallback(() => {
    const isCurrent = begin()
    setLoading(true)
    setError('')
    return api.get('/payments/history', {
      params: { page, pageSize: PAGE_SIZE, includeAbandoned: showAbandoned ? 1 : undefined },
    })
      .then(res => {
        if (!isCurrent()) return
        const data = res.data.data
        setPayments(data.payments)
        setTotal(data.total ?? data.payments.length)
        // Landed past the last page (a cancel/toggle shrank the list): step back.
        if (data.payments.length === 0 && page > 1) setPage(p => Math.max(1, p - 1))
      })
      .catch(err => { if (isCurrent()) setError(getErrorMessage(err, 'Failed to load payment history.')) })
      .finally(() => { if (isCurrent()) setLoading(false) })
  }, [page, showAbandoned])

  useEffect(() => { load() }, [load])

  function toggleAbandoned(e) {
    setShowAbandoned(e.target.checked)
    setPage(1)
  }

  // FEATURE GAP CLOSED (Payments & Pricing round 2 — G1): POST
  // /payments/:reference/receipt (owner-only, 3/hour) and the receiptAvailable
  // flag on each row were built and tested but had no caller — a buyer whose
  // receipt email was lost still had no way to get it again.
  async function sendReceipt(p) {
    patchRow(p.paystackRef, { busy: true, note: '' })
    try {
      const res = await api.post(`/payments/${encodeURIComponent(p.paystackRef)}/receipt`)
      patchRow(p.paystackRef, { busy: false, note: res.data.message || 'Receipt sent.', noteTone: 'ok' })
    } catch (err) {
      patchRow(p.paystackRef, { busy: false, note: getErrorMessage(err, 'Could not send the receipt.'), noteTone: 'error' })
    }
  }

  // FEATURE GAP CLOSED (Payments & Pricing round 2 — G5): a checkout left
  // PENDING could only be cancelled from the checkout screen, after hitting the
  // 409. Someone looking at a stale "Pending" row here had nothing to click.
  // Same endpoint, same server-side guarantee: it only ever flips a PENDING row
  // that belongs to the caller, so a payment that completes in the meantime
  // cannot be cancelled out from under the buyer.
  async function runCancel() {
    const p = confirmCancel
    if (!p) return
    setCancelling(true)
    try {
      await api.post(`/payments/${encodeURIComponent(p.paystackRef)}/cancel`)
      setConfirmCancel(null)
      await load()
    } catch (err) {
      setConfirmCancel(null)
      patchRow(p.paystackRef, { note: getErrorMessage(err, 'Could not cancel that checkout.'), noteTone: 'error' })
      load()
    } finally {
      setCancelling(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-bold text-gray-900">Payment history</h1>
          <Checkbox wrapperClassName="text-gray-500" label="Show unfinished checkouts" checked={showAbandoned} onChange={toggleAbandoned} />
        </div>

        {loading && payments.length === 0 ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <p role="alert" className="text-sm text-red-600">{error}</p>
        ) : payments.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <p className="text-sm text-gray-500">
              No payments yet — your purchases will show up here once you fix a resume or buy a credential.
            </p>
          </div>
        ) : (
          <div className={`border border-gray-200 rounded-lg bg-white overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-sm">
              <caption className="sr-only">Your payments</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                  <th scope="col" className="px-4 py-3">Date</th>
                  <th scope="col" className="px-4 py-3">Item</th>
                  <th scope="col" className="px-4 py-3 text-right">Amount</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payments.map(p => {
                  const row = rowState[p.paystackRef] || {}
                  return (
                    <tr key={p.id}>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(p.paidAt || p.createdAt)}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {TIER_LABEL[p.fixTier] || p.fixTier || '—'}
                        {isFreeCredit(p) && <span className="text-xs text-gray-400 ml-1.5">(free credit)</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-medium">
                        {isFreeCredit(p) ? <span className="text-gray-400">Free</span> : formatCents(p.amountCents, p.currency)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATUS_VARIANT[p.status] || 'gray'}>{p.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3 flex-wrap">
                          {p.scanId && (
                            <Link to={`/scan/${p.scanId}`} className="text-xs text-blue-600 hover:underline whitespace-nowrap">
                              View scan →
                            </Link>
                          )}
                          {p.receiptAvailable && (
                            <Button size="sm" variant="ghost" loading={!!row.busy} disabled={!!row.busy}
                              onClick={() => sendReceipt(p)}>
                              Email receipt
                            </Button>
                          )}
                          {p.status === 'PENDING' && (
                            <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(p)}>
                              Cancel checkout
                            </Button>
                          )}
                        </div>
                        {row.note && (
                          <p role="status" className={`text-xs mt-1 ${row.noteTone === 'error' ? 'text-red-600' : 'text-emerald-700'}`}>
                            {row.note}
                          </p>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={page} totalPages={totalPages} onChange={setPage} />

        <ConfirmDialog
          open={!!confirmCancel}
          title="Cancel this checkout?"
          message={'This closes the unfinished checkout so you can start a new one. If you have already paid, do not cancel — it will finish on its own.'}
          confirmLabel="Cancel checkout"
          cancelLabel="Keep it"
          danger={false}
          loading={cancelling}
          onConfirm={runCancel}
          onCancel={() => setConfirmCancel(null)}
        />
      </div>
    </DashboardLayout>
  )
}
