import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { formatDate, formatCents } from '../../lib/utils'

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

export default function PaymentHistory() {
  const [payments, setPayments] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  useEffect(() => {
    api.get('/payments/history')
      .then(res => setPayments(res.data.data.payments))
      .catch(err => setError(getErrorMessage(err, 'Failed to load payment history.')))
      .finally(() => setLoading(false))
  }, [])

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-gray-900">Payment history</h1>

        {loading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : payments.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
            <p className="text-sm text-gray-500">
              No payments yet — your purchases will show up here once you fix a resume or buy a credential.
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {payments.map(p => (
                  <tr key={p.id}>
                    <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{formatDate(p.createdAt)}</td>
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
                      {p.scanId && (
                        <Link to={`/scan/${p.scanId}`} className="text-xs text-blue-600 hover:underline whitespace-nowrap">
                          View scan →
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
