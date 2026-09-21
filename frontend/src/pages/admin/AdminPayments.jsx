import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatDate, formatCents } from '../../lib/utils'

const PAGE_SIZE = 25
const STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'ABANDONED']

export default function AdminPayments() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get('status') || ''
  const [payments, setPayments] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [busyRef, setBusyRef] = useState(null)

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

  // AUDIT FIX (Admin panel re-audit): the reconcile endpoint (Sections
  // 11+12 — recovers a payment that charged successfully but whose
  // fulfillment/commission-write failed) existed on the backend with no
  // way to trigger it from here at all. Safe to offer on any SUCCESS
  // payment: it's idempotent — a payment that's actually fine just comes
  // back "Already fulfilled — nothing to do."
  async function reconcile(payment) {
    if (!window.confirm(
      `Reconcile ${payment.paystackRef}? This re-attempts fix delivery and the partner-commission ` +
      `write for this payment. Safe to run even if it already succeeded — it's a no-op in that case.`
    )) return
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
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const badgeVariant = s => ({ SUCCESS: 'green', PENDING: 'amber', FAILED: 'red', ABANDONED: 'gray' }[s] || 'gray')

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
                  <td className="px-4 py-3"><Badge variant={badgeVariant(p.status)}>{p.status}</Badge></td>
                  <td className="px-4 py-3 text-gray-500">{p.fixTier || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{p.referralCode || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {p.status === 'SUCCESS' && (
                      <Button size="sm" variant="secondary" disabled={busyRef === p.paystackRef}
                        onClick={() => reconcile(p)}>
                        Reconcile
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
